import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { directory } from "../lib/auth";
import {
	connection,
	provider,
	ProviderError,
	digest,
	type Connection,
} from "./infrastructure";
import type {
	DomainHealth,
	DomainCheck,
	DNSRecord,
} from "../../shared/domain-health";
export interface DomainRow {
	name: string;
	enabled: number;
	receive_enabled: number;
	send_enabled: number;
	connection_id: string | null;
	send_connection_id: string | null;
	setup_mode: string;
	zone_id: string | null;
	worker_name: string | null;
	dkim_selector: string;
	health_json: string | null;
	last_receive_at: string | null;
	setup_changed_at: string | null;
	last_send_at: string | null;
	last_send_error: string | null;
	relay_key: string | null;
}
export async function domainRow(env: Env, name: string) {
	const row = await directory(env)
		.prepare("SELECT * FROM domains WHERE name=?")
		.bind(name)
		.first<DomainRow>();
	if (!row) throw new HTTPException(404, { message: "域名不存在" });
	return row;
}
export async function dns(name: string, type: "MX" | "NS" | "TXT" | "CNAME") {
	const r = await fetch(
		`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`,
		{
			headers: { Accept: "application/dns-json" },
			signal: AbortSignal.timeout(10000),
		},
	);
	if (!r.ok) throw new Error("DNS unavailable");
	const d = (await r.json()) as {
		Status: number;
		Answer?: { type: number; data: string }[];
	};
	if (![0, 3].includes(d.Status)) throw new Error("DNS resolution failed");
	const types = { MX: 15, NS: 2, TXT: 16, CNAME: 5 };
	return (d.Answer || [])
		.filter((x) => x.type === types[type])
		.map((x) => x.data)
		.sort();
}
const txt = (v: string) => v.replace(/"\s*"/g, "").replace(/^"|"$/g, "");
export function cloudflareMX(values: string[]) {
	return (
		values.length > 0 &&
		values.every((x) => /\broute\d*\.mx\.cloudflare\.net\.?$/i.test(x))
	);
}
function failed(id: string, label: string, e: unknown): DomainCheck {
	return {
		id,
		label,
		state:
			e instanceof ProviderError && [401, 403].includes(e.status)
				? "permission"
				: "error",
		detail:
			e instanceof ProviderError
				? e.message
				: "检测暂不可用，请重试；不会据此判定配置缺失",
	};
}
export async function inspectDomain(env: Env, row: DomainRow) {
	const checks: DomainCheck[] = [];
	const data: Record<string, any> = {};
	const c = await connection(env, row.connection_id);
	const health: DomainHealth = {
		checkedAt: new Date().toISOString(),
		checks,
		requiredRecords: [],
		crossAccount:
			!!c?.account_id &&
			!!env.INBOX_ACCOUNT_ID &&
			c.account_id !== env.INBOX_ACCOUNT_ID,
		lastReceiveAt: row.last_receive_at || undefined,
		lastSendAt: row.last_send_at || undefined,
		lastSendError: row.last_send_error || undefined,
	};
	await Promise.all(
		[
			["ns", "DNS 托管", row.name, "NS"],
			["mx", "收信 MX", row.name, "MX"],
			["spf", "SPF", row.name, "TXT"],
			["dmarc", "DMARC", "_dmarc." + row.name, "TXT"],
		].map(async ([id, label, name, type]) => {
			try {
				const values = await dns(name, type as "NS" | "MX" | "TXT");
				data[id] = values;
				let state: DomainCheck["state"] = "passed",
					detail = "";
				if (id === "ns") {
					state = values.length ? "passed" : "missing";
					detail = values.some((x) => x.endsWith(".ns.cloudflare.com."))
						? "DNS 托管于 Cloudflare"
						: "未检测到 Cloudflare NS；子域名可能继承父域名托管，请核对所属 Zone";
				}
				if (id === "mx") {
					state = cloudflareMX(values)
						? "passed"
						: values.length
							? "warning"
							: "missing";
					detail = cloudflareMX(values)
						? "全部 MX 指向 Cloudflare（尚不代表路由或实际收信通过）"
						: values.length
							? "检测到其他收信服务；自动配置不会覆盖"
							: "尚无 MX 记录";
				}
				if (id === "spf") {
					const spf = values.map(txt).filter((x) => /^v=spf1\b/i.test(x));
					state =
						spf.length === 1 ? "passed" : spf.length ? "warning" : "missing";
					detail =
						spf.length === 1
							? "检测到一条 SPF，需与实际发信服务匹配"
							: spf.length
								? "存在多条 SPF，需要合并"
								: "未检测到 SPF";
				}
				if (id === "dmarc") {
					state = values.some((x) => /^v=DMARC1\b/i.test(txt(x)))
						? "passed"
						: "missing";
					detail =
						state === "passed"
							? "已发布 DMARC 策略（策略强度需管理员确认）"
							: "尚未发布 DMARC；建议先监测，再逐步收紧策略";
				}
				checks.push({ id, label, state, detail, records: values });
			} catch (e) {
				checks.push(failed(id, label, e));
			}
		}),
	);
	let zone: any = null,
		catchAll: any = null,
		rules: any[] = [];
	if (row.setup_mode === "cloudflare" && c?.provider === "cloudflare") {
		try {
			zone = row.zone_id
				? await provider(env, c, `/zones/${row.zone_id}`)
				: (
						await provider(
							env,
							c,
							`/zones?name=${encodeURIComponent(row.name)}&account.id=${c.account_id}`,
						)
					)[0];
			if (
				!zone ||
				zone.account?.id !== c.account_id ||
				!(row.name === zone.name || row.name.endsWith("." + zone.name))
			)
				throw new HTTPException(400, {
					message: "所选账户或 Zone 与该域名不匹配",
				});
			health.zoneId = zone.id;
			data.zone = { id: zone.id, name: zone.name, status: zone.status };
			checks.push({
				id: "zone",
				label: "Cloudflare 账户与 Zone",
				state: zone.status === "active" ? "passed" : "warning",
				detail: `${zone.name} · ${zone.status}`,
			});
		} catch (e) {
			zone = null;
			checks.push(
				e instanceof HTTPException && e.status === 400
					? {
							id: "zone",
							label: "Cloudflare 账户与 Zone",
							state: "missing",
							detail: e.message,
						}
					: failed("zone", "Cloudflare 账户与 Zone", e),
			);
		}
		if (zone) {
			const worker = health.crossAccount
				? `inbox-relay-${(await digest(row.name)).slice(0, 12)}`
				: env.INBOX_WORKER_NAME;
			health.workerName = worker;
			await Promise.all([
				(async () => {
					try {
						const r = await provider(env, c, `/zones/${zone.id}/email/routing`);
						data.routing = { enabled: r.enabled, status: r.status };
						checks.push({
							id: "routing",
							label: "Email Routing",
							state: r.enabled ? "passed" : "missing",
							detail: r.enabled ? "服务已启用" : "服务尚未启用",
						});
					} catch (e) {
						if (e instanceof ProviderError && e.status === 404) {
							data.routing = { enabled: false };
							checks.push({
								id: "routing",
								label: "Email Routing",
								state: "missing",
								detail: "服务尚未返回已开通配置",
							});
						} else checks.push(failed("routing", "Email Routing", e));
					}
				})(),
				(async () => {
					try {
						catchAll = await provider(
							env,
							c,
							`/zones/${zone.id}/email/routing/rules/catch_all`,
						);
						data.catchAll = {
							enabled: !!catchAll.enabled,
							actions: catchAll.actions,
							matchers: catchAll.matchers,
						};
						const ok =
							!!worker &&
							catchAll.enabled &&
							catchAll.actions?.length === 1 &&
							catchAll.actions[0].type === "worker" &&
							catchAll.actions[0].value?.length === 1 &&
							catchAll.actions[0].value[0] === worker;
						checks.push({
							id: "catch_all",
							label: "Catch-all 目标",
							state: ok ? "passed" : catchAll.enabled ? "warning" : "missing",
							detail: !worker
								? "主 Worker 名称未配置"
								: ok
									? `指向 ${worker}`
									: catchAll.enabled
										? "现有路由指向其他目标，不会自动覆盖"
										: `尚未指向 ${worker}`,
						});
					} catch (e) {
						if (e instanceof ProviderError && e.status === 404) {
							catchAll = { enabled: false, actions: [] };
							data.catchAll = catchAll;
							checks.push({
								id: "catch_all",
								label: "Catch-all 目标",
								state: "missing",
								detail: "尚无 Catch-all 配置",
							});
						} else checks.push(failed("catch_all", "Catch-all 目标", e));
					}
				})(),
				(async () => {
					try {
						const r = await provider(
							env,
							c,
							`/zones/${zone.id}/email/routing/rules?per_page=100`,
						);
						rules = r.filter((v: any) => v.enabled);
						data.rules = rules.map((v: any) => ({
							id: v.id,
							actions: v.actions,
							matchers: v.matchers,
						}));
						checks.push({
							id: "rules",
							label: "地址级路由",
							state: rules.length ? "warning" : "passed",
							detail: rules.length
								? `存在 ${rules.length} 条启用的独立规则，可能优先于 Catch-all；请在控制台核对，超过 100 条时以控制台为准`
								: "未发现优先匹配的独立地址规则",
						});
					} catch (e) {
						if (e instanceof ProviderError && e.status === 404) {
							data.rules = [];
							checks.push({
								id: "rules",
								label: "地址级路由",
								state: "missing",
								detail: "服务尚无地址规则配置",
							});
						} else checks.push(failed("rules", "地址级路由", e));
					}
				})(),
				(async () => {
					try {
						const r = await provider(
							env,
							c,
							`/zones/${zone.id}/email/routing/dns?name=${encodeURIComponent(row.name)}`,
						);
						if (!Array.isArray(r)) throw new Error();
						health.requiredRecords = r.map((v: DNSRecord) => ({
							type: v.type,
							name: v.name,
							content: v.content,
							...(v.priority === undefined ? {} : { priority: v.priority }),
						}));
						data.requiredRecords = health.requiredRecords;
					} catch (e) {
						checks.push(failed("required_dns", "服务要求的 DNS 记录", e));
					}
				})(),
			]);
			if (health.crossAccount) {
				try {
					const r = await provider(
						env,
						c,
						`/accounts/${c.account_id}/workers/scripts/${worker}/settings`,
					);
					const b = r.bindings || [];
					const ok =
						r.tags?.includes("agentic-inbox-domain-relay") &&
						b.some(
							(x: any) => x.name === "INBOX_DOMAIN" && x.text === row.name,
						) &&
						b.some(
							(x: any) =>
								x.name === "INBOX_MAIN_ACCOUNT" &&
								x.text === env.INBOX_ACCOUNT_ID,
						) &&
						b.some(
							(x: any) =>
								x.name === "INBOX_MAIN_WORKER" &&
								x.text === env.INBOX_WORKER_NAME,
						);
					checks.push({
						id: "relay",
						label: "跨账户接入 Worker",
						state: ok ? "passed" : "warning",
						detail: ok
							? "已部署本站专用接入 Worker；仍需实际收信验证"
							: "同名 Worker 不属于此域名接入配置，禁止覆盖",
					});
				} catch (e) {
					checks.push(
						e instanceof ProviderError && e.status === 404
							? {
									id: "relay",
									label: "跨账户接入 Worker",
									state: "missing",
									detail: "需要先部署跨账户接入 Worker",
								}
							: failed("relay", "跨账户接入 Worker", e),
					);
				}
			}
		}
	} else
		checks.push({
			id: "zone",
			label: "账户与路由检查",
			state: "unknown",
			detail:
				row.setup_mode === "external"
					? "外部服务模式：按下方签名接入协议连接收信，路由需在服务商侧配置"
					: "请先绑定 Cloudflare 账户连接，授权后才能核对服务和路由",
		});
	const sender = await connection(
		env,
		row.send_connection_id || row.connection_id,
	);
	let selector = row.dkim_selector;
	try {
		if (sender?.provider === "resend") {
			const r = await provider(env, sender, "/domains");
			const d = r.data?.find((x: any) => x.name === row.name);
			if (d) {
				const v = await provider(env, sender, "/domains/" + d.id);
				data.sender = v;
				checks.push({
					id: "sender",
					label: "发信服务验证",
					state: v.status === "verified" ? "passed" : "missing",
					detail: `Resend 域名状态：${v.status}`,
				});
				for (const x of v.records || [])
					health.requiredRecords.push({
						type: x.type,
						name: x.name,
						content: x.value,
						...(x.priority === undefined ? {} : { priority: x.priority }),
					});
			} else
				checks.push({
					id: "sender",
					label: "发信服务验证",
					state: "missing",
					detail: "Resend 尚未登记此域名，请在 Resend 完成域名验证",
				});
		} else if (
			sender?.provider === "cloudflare" &&
			zone &&
			sender.account_id === c?.account_id
		) {
			const r = await provider(
				env,
				sender,
				`/zones/${zone.id}/email/sending/subdomains`,
			);
			const d = r.find((x: any) => x.name === row.name);
			data.sender = d || null;
			selector = selector || d?.dkim_selector || "";
			checks.push({
				id: "sender",
				label: "发信服务验证",
				state: d?.enabled ? "passed" : "missing",
				detail: d?.enabled
					? "Cloudflare 已启用此发信域名，实际发送仍受账户配额和限制影响"
					: "Cloudflare 发信域名尚未启用",
			});
		} else
			checks.push({
				id: "sender",
				label: "发信服务验证",
				state: "unknown",
				detail: "未绑定可核实的发信连接；系统发信开关不代表服务已验证",
			});
	} catch (e) {
		if (
			e instanceof ProviderError &&
			e.status === 404 &&
			sender?.provider === "cloudflare"
		) {
			data.sender = null;
			checks.push({
				id: "sender",
				label: "发信服务验证",
				state: "missing",
				detail: "Cloudflare 尚未返回发信域名配置，请确认账户服务可用后开通",
			});
		} else checks.push(failed("sender", "发信服务验证", e));
	}
	if (selector) {
		try {
			const names = selector
				.split(",")
				.map((x) => x.trim())
				.filter(Boolean)
				.slice(0, 5);
			const records = (
				await Promise.all(
					names.map(async (n) => [
						...(await dns(`${n}._domainkey.${row.name}`, "TXT")),
						...(await dns(`${n}._domainkey.${row.name}`, "CNAME")),
					]),
				)
			).flat();
			checks.push({
				id: "dkim",
				label: "DKIM",
				state: records.length ? "passed" : "missing",
				detail: records.length
					? "检测到所指定选择器的 DKIM 记录；不等于签名验证通过"
					: "未检测到指定选择器的 DKIM 记录",
				records,
			});
		} catch (e) {
			checks.push(failed("dkim", "DKIM", e));
		}
	} else
		checks.push({
			id: "dkim",
			label: "DKIM",
			state: "unknown",
			detail: "需从发信服务获取 DKIM 选择器，不能凭空推断",
		});
	checks.push({
		id: "receive_test",
		label: "实际收信",
		state:
			row.last_receive_at &&
			(!row.setup_changed_at || row.last_receive_at >= row.setup_changed_at)
				? "passed"
				: "unknown",
		detail: row.last_receive_at
			? `最近成功入库：${row.last_receive_at}${row.setup_changed_at && row.last_receive_at < row.setup_changed_at ? "（发生在接入设置变更前，请重新测试）" : ""}`
			: "尚无已记录的收信；可生成收信测试地址",
	});
	checks.push({
		id: "send_test",
		label: "发信服务接受记录",
		state: row.last_send_error
			? "error"
			: row.last_send_at &&
				  (!row.setup_changed_at || row.last_send_at >= row.setup_changed_at)
				? "passed"
				: "unknown",
		detail: row.last_send_error
			? row.last_send_error
			: row.last_send_at
				? `服务最近接受发送：${row.last_send_at}；不代表对方已收件${row.setup_changed_at && row.last_send_at < row.setup_changed_at ? "；此记录发生在接入设置变更前，请重新测试" : ""}`
				: "尚无已记录的发送；可向指定测试收件人发送一封邮件",
	});
	checks.sort(
		(a, b) =>
			[
				"zone",
				"ns",
				"mx",
				"spf",
				"dkim",
				"dmarc",
				"routing",
				"catch_all",
				"rules",
				"relay",
				"required_dns",
				"sender",
				"receive_test",
				"send_test",
			].indexOf(a.id) -
			[
				"zone",
				"ns",
				"mx",
				"spf",
				"dkim",
				"dmarc",
				"routing",
				"catch_all",
				"rules",
				"relay",
				"required_dns",
				"sender",
				"receive_test",
				"send_test",
			].indexOf(b.id),
	);
	return { health, data, connection: c, zone, catchAll, rules };
}
export async function saveHealth(env: Env, name: string, health: DomainHealth) {
	await directory(env)
		.prepare(
			"UPDATE domains SET health_json=?,checked_at=?,mx_verified=? WHERE name=?",
		)
		.bind(
			JSON.stringify(health),
			health.checkedAt,
			Number(health.checks.some((x) => x.id === "mx" && x.state === "passed")),
			name,
		)
		.run();
}
export async function configurationPlan(
	env: Env,
	row: DomainRow,
	enableSending: boolean,
) {
	const s = await inspectDomain(env, row),
		blockers: string[] = [],
		warnings: string[] = [],
		changes: string[] = [];
	if (
		row.setup_mode !== "cloudflare" ||
		s.connection?.provider !== "cloudflare" ||
		!s.zone
	)
		blockers.push("自动配置需要有效的 Cloudflare 连接与匹配的 Zone");
	if (s.zone && (s.zone.status !== "active" || s.zone.name !== row.name))
		blockers.push(
			"自动配置仅用于已激活的独立 Zone 根域名；子域名请按服务商向导配置，不修改父域名 Catch-all",
		);
	for (const id of ["mx", "spf", "routing", "catch_all", "rules"]) {
		const x = s.health.checks.find((x) => x.id === id);
		if (!x || ["error", "permission", "unknown"].includes(x.state))
			blockers.push(`无法完整读取 ${x?.label || id}，请先补齐权限或重新检测`);
	}
	if (s.data.mx?.length && !cloudflareMX(s.data.mx))
		blockers.push(
			"现有 MX 指向其他邮件服务，请先在服务商侧规划迁移，不自动覆盖",
		);
	const spf = (s.data.spf || [])
		.map(txt)
		.filter((x: string) => /^v=spf1\b/i.test(x));
	if (
		spf.length > 1 ||
		(spf.length === 1 && !/include:_spf\.mx\.cloudflare\.net\b/i.test(spf[0]))
	)
		blockers.push("已有 SPF 需要人工合并，不自动覆盖或创建第二条 SPF");
	if (
		s.catchAll?.enabled &&
		!s.health.checks.some((x) => x.id === "catch_all" && x.state === "passed")
	)
		blockers.push("现有 Catch-all 指向其他目标，不自动覆盖");
	if (s.rules.length)
		warnings.push(
			"已有独立地址规则保持不变，可能优先于 Catch-all，请核对这些地址",
		);
	if (!s.health.workerName)
		blockers.push("未确定目标 Worker，请检查部署环境配置");
	if (
		s.health.crossAccount &&
		!s.health.checks.some((x) => x.id === "relay" && x.state === "passed")
	)
		blockers.push("先部署跨账户接入 Worker，再生成自动配置预览");
	if (!s.health.requiredRecords.length)
		blockers.push("未取得 Cloudflare 要求的 DNS 记录，无法生成自动配置");
	if (
		s.health.checks.some((x) => x.id === "routing" && x.state !== "passed") ||
		!cloudflareMX(s.data.mx || [])
	)
		changes.push(
			"启用 Email Routing，使用服务返回的 DNS 配置（不会替换其他服务的 MX/SPF）",
		);
	if (
		!s.health.checks.some((x) => x.id === "catch_all" && x.state === "passed")
	)
		changes.push(`设置 Catch-all → ${s.health.workerName || "未确定"}`);
	if (enableSending) {
		if (row.send_connection_id && row.send_connection_id !== row.connection_id)
			blockers.push(
				"独立发信连接请在对应服务商完成开通，本预览只配置所选 Cloudflare 账户",
			);
		const st = s.health.checks.find((x) => x.id === "sender");
		if (!st || ["error", "permission", "unknown"].includes(st.state))
			blockers.push("无法核实发信服务状态，不能自动开通");
		else if (st.state !== "passed")
			changes.push(
				"启用 Cloudflare Email Sending 域名（需已开通服务，可能涉及服务用量计费）",
			);
	}
	const fingerprint = await digest(
		canonical({
			config: [
				row.connection_id,
				row.send_connection_id,
				row.zone_id,
				row.setup_mode,
				row.dkim_selector,
				env.INBOX_WORKER_NAME,
			],
			data: {
				...s.data,
				mx: (s.data.mx || [])
					.map((x: string) => x.replace(/^\d+\s+/, ""))
					.sort(),
			},
			enableSending,
		}),
	);
	return {
		...s,
		blockers: [...new Set(blockers)],
		warnings,
		changes,
		fingerprint,
	};
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
	if (value && typeof value === "object")
		return (
			"{" +
			Object.keys(value)
				.sort()
				.map(
					(k) =>
						JSON.stringify(k) +
						":" +
						canonical((value as Record<string, unknown>)[k]),
				)
				.join(",") +
			"}"
		);
	return JSON.stringify(value) ?? "null";
}
