import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { directory, requireAdmin } from "../lib/auth";
import type { MailboxContext } from "../lib/mailbox";
import {
	audit,
	randomToken,
	rateLimit,
	consumeQuota,
} from "../domain/accounts";
import {
	domainRow,
	inspectDomain,
	saveHealth,
	configurationPlan,
} from "../domain/domain-health";
import { normalizeDomain, assertSender } from "../domain/mailboxes";
import {
	seal,
	unseal,
	connection,
	provider,
	ProviderError,
	digest,
} from "../domain/infrastructure";
import { relaySource } from "../domain/relay";
import { sendEmail } from "../email-sender";
export const domainApp = new Hono<MailboxContext>();
domainApp.use("/api/v1/admin/*", async (c, next) => {
	await requireAdmin(c.env, c.var.principal);
	await next();
});
domainApp.use(
	"/api/v1/admin/*",
	bodyLimit({
		maxSize: 32768,
		onError: (c) => c.json({ error: "请求过大" }, 413),
	}),
);
const id = z.string().uuid();
const path = "/api/v1/admin/domain-connections";
domainApp.get(path, async (c) =>
	c.json({
		encryptionReady: !!c.env.DOMAIN_CONFIG_KEY,
		connections: (
			await directory(c.env)
				.prepare(
					"SELECT id,name,provider,account_id,created_at FROM provider_connections ORDER BY name",
				)
				.all()
		).results,
		accountId: c.env.INBOX_ACCOUNT_ID || null,
		workerName: c.env.INBOX_WORKER_NAME || null,
	}),
);
domainApp.post(path, async (c) => {
	const b = z
		.object({
			name: z.string().min(1).max(80),
			provider: z.enum(["cloudflare", "resend"]),
			accountId: z
				.string()
				.regex(/^[a-f0-9]{32}$/)
				.optional(),
			token: z.string().min(16).max(4096),
		})
		.parse(await c.req.json());
	if (b.provider === "cloudflare" && !b.accountId)
		throw new HTTPException(400, { message: "Cloudflare 连接需要账户 ID" });
	const connectionId = crypto.randomUUID();
	const credential = await seal(c.env, b.token, connectionId);
	await directory(c.env)
		.prepare(
			"INSERT INTO provider_connections(id,name,provider,account_id,credential) VALUES (?,?,?,?,?)",
		)
		.bind(connectionId, b.name, b.provider, b.accountId || null, credential)
		.run();
	await audit(c.env, c.var.principal, "connection.create", connectionId, {
		provider: b.provider,
		name: b.name,
	});
	return c.json({ id: connectionId }, 201);
});
domainApp.put(path + "/:id", async (c) => {
	const b = z
		.object({ token: z.string().min(16).max(4096) })
		.parse(await c.req.json());
	const connectionId = id.parse(c.req.param("id"));
	await directory(c.env)
		.prepare("UPDATE provider_connections SET credential=? WHERE id=?")
		.bind(await seal(c.env, b.token, connectionId), connectionId)
		.run();
	await audit(c.env, c.var.principal, "connection.rotate", connectionId);
	return c.json({ ok: true });
});
domainApp.delete(path + "/:id", async (c) => {
	const connectionId = id.parse(c.req.param("id"));
	if (
		await directory(c.env)
			.prepare(
				"SELECT name FROM domains WHERE connection_id=? OR send_connection_id=?",
			)
			.bind(connectionId, connectionId)
			.first()
	)
		throw new HTTPException(409, { message: "连接仍被域名使用，请先解除绑定" });
	await directory(c.env)
		.prepare("DELETE FROM provider_connections WHERE id=?")
		.bind(connectionId)
		.run();
	await audit(c.env, c.var.principal, "connection.delete", connectionId);
	return c.json({ ok: true });
});
const base = "/api/v1/admin/domains/manage/:domain";
domainApp.put(base + "/setup", async (c) => {
	const name = normalizeDomain(c.req.param("domain")!);
	const old = await domainRow(c.env, name);
	const b = z
		.object({
			mode: z.enum(["cloudflare", "external"]),
			connectionId: id.nullable(),
			sendConnectionId: id.nullable(),
			zoneId: z
				.string()
				.regex(/^[a-f0-9]{32}$/)
				.nullable(),
			dkimSelector: z
				.string()
				.max(250)
				.regex(/^([a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*)?$/),
		})
		.parse(await c.req.json());
	for (const cid of [b.connectionId, b.sendConnectionId])
		if (cid && !(await connection(c.env, cid)))
			throw new HTTPException(400, { message: "连接不存在" });
	if (
		b.connectionId &&
		(await connection(c.env, b.connectionId))?.provider !== "cloudflare"
	)
		throw new HTTPException(400, {
			message: "收信自动配置需要 Cloudflare 连接",
		});
	await directory(c.env)
		.prepare(
			"UPDATE domains SET setup_mode=?,connection_id=?,send_connection_id=?,zone_id=?,dkim_selector=?,health_json=NULL,relay_key=CASE WHEN ? THEN NULL ELSE relay_key END,setup_changed_at=CASE WHEN ? THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE setup_changed_at END,last_send_error=CASE WHEN ? THEN NULL ELSE last_send_error END WHERE name=?",
		)
		.bind(
			b.mode,
			b.connectionId,
			b.sendConnectionId,
			b.zoneId,
			b.dkimSelector,
			Number(old.connection_id !== b.connectionId || old.setup_mode !== b.mode),
			Number(
				old.connection_id !== b.connectionId ||
					old.setup_mode !== b.mode ||
					old.send_connection_id !== b.sendConnectionId ||
					old.zone_id !== b.zoneId,
			),
			Number(
				old.connection_id !== b.connectionId ||
					old.setup_mode !== b.mode ||
					old.send_connection_id !== b.sendConnectionId ||
					old.zone_id !== b.zoneId,
			),
			name,
		)
		.run();
	await audit(c.env, c.var.principal, "domain.setup", name, b);
	return c.json({ ok: true });
});
domainApp.post(base + "/health", async (c) => {
	const name = normalizeDomain(c.req.param("domain")!);
	await rateLimit(c.env, "domain-health:" + name, 30, 3600);
	const r = await inspectDomain(c.env, await domainRow(c.env, name));
	await saveHealth(c.env, name, r.health);
	return c.json(r.health);
});
domainApp.post(base + "/plan", async (c) => {
	const name = normalizeDomain(c.req.param("domain")!);
	const b = z
		.object({ enableSending: z.boolean().default(false) })
		.parse(await c.req.json());
	await rateLimit(c.env, "domain-plan:" + name, 30, 3600);
	const p = await configurationPlan(
		c.env,
		await domainRow(c.env, name),
		b.enableSending,
	);
	const planId = crypto.randomUUID(),
		expires = Math.floor(Date.now() / 1000) + 600;
	await directory(c.env).batch([
		directory(c.env)
			.prepare("DELETE FROM domain_plans WHERE expires_at<?")
			.bind(Math.floor(Date.now() / 1000)),
		directory(c.env)
			.prepare(
				"INSERT INTO domain_plans(id,domain,fingerprint,enable_sending,expires_at) VALUES (?,?,?,?,?)",
			)
			.bind(planId, name, p.fingerprint, Number(b.enableSending), expires),
	]);
	await saveHealth(c.env, name, p.health);
	return c.json({
		id: planId,
		expiresAt: expires,
		blockers: p.blockers,
		warnings: p.warnings,
		changes: p.changes,
		health: p.health,
	});
});
domainApp.post(base + "/apply", async (c) => {
	const name = normalizeDomain(c.req.param("domain")!);
	const b = z.object({ planId: id }).parse(await c.req.json());
	const db = directory(c.env);
	const saved = await db
		.prepare(
			"SELECT * FROM domain_plans WHERE id=? AND domain=? AND used=0 AND expires_at>?",
		)
		.bind(b.planId, name, Math.floor(Date.now() / 1000))
		.first<{ fingerprint: string; enable_sending: number }>();
	if (!saved)
		throw new HTTPException(409, { message: "预览已过期或已执行，请重新生成" });
	const row = await domainRow(c.env, name);
	const p = await configurationPlan(c.env, row, !!saved.enable_sending);
	if (p.blockers.length)
		throw new HTTPException(409, { message: p.blockers.join("；") });
	if (p.fingerprint !== saved.fingerprint)
		throw new HTTPException(409, {
			message: "配置已发生变化，请重新检查变更预览",
		});
	const lock = await db
		.prepare(
			"UPDATE domain_plans SET used=1 WHERE id=? AND used=0 AND expires_at>?",
		)
		.bind(b.planId, Math.floor(Date.now() / 1000))
		.run();
	if (!lock.meta.changes)
		throw new HTTPException(409, { message: "预览已被执行" });
	const completed: string[] = [];
	try {
		if (p.changes.some((x) => x.startsWith("启用 Email Routing"))) {
			await provider(
				c.env,
				p.connection!,
				`/zones/${p.zone.id}/email/routing/dns`,
				"POST",
				{ name },
			);
			completed.push("Email Routing / DNS");
		}
		if (p.changes.some((x) => x.startsWith("设置 Catch-all"))) {
			await provider(
				c.env,
				p.connection!,
				`/zones/${p.zone.id}/email/routing/rules/catch_all`,
				"PUT",
				{
					enabled: true,
					matchers: [{ type: "all" }],
					actions: [{ type: "worker", value: [p.health.workerName] }],
				},
			);
			completed.push("Catch-all");
		}
		if (p.changes.some((x) => x.startsWith("启用 Cloudflare Email Sending"))) {
			await provider(
				c.env,
				p.connection!,
				`/zones/${p.zone.id}/email/sending/subdomains`,
				"POST",
				{ name },
			);
			completed.push("Email Sending");
		}
		await audit(c.env, c.var.principal, "domain.apply", name, { completed });
		const r = await inspectDomain(c.env, await domainRow(c.env, name));
		await saveHealth(c.env, name, r.health);
		return c.json({ ok: true, completed, health: r.health });
	} catch {
		await audit(c.env, c.var.principal, "domain.apply-failed", name, {
			completed,
		});
		await db
			.prepare("UPDATE domains SET health_json=NULL WHERE name=?")
			.bind(name)
			.run();
		return c.json(
			{
				error: `配置未全部完成；已完成：${completed.join("、") || "无"}。请重新检测，系统不会回滚删除已有 DNS 或路由。`,
				completed,
			},
			502,
		);
	}
});
domainApp.post(base + "/relay", async (c) => {
	const name = normalizeDomain(c.req.param("domain")!);
	const row = await domainRow(c.env, name);
	const b = z
		.object({ action: z.enum(["deploy", "credentials"]) })
		.parse(await c.req.json());
	if (new URL(c.req.url).protocol !== "https:")
		throw new HTTPException(400, { message: "接入服务需要 HTTPS 地址" });
	let secret = row.relay_key
		? await unseal(c.env, row.relay_key, "relay:" + name)
		: randomToken();
	if (!row.relay_key) {
		const cipher = await seal(c.env, secret, "relay:" + name);
		const r = await directory(c.env)
			.prepare(
				"UPDATE domains SET relay_key=? WHERE name=? AND relay_key IS NULL",
			)
			.bind(cipher, name)
			.run();
		if (!r.meta.changes)
			secret = await unseal(
				c.env,
				(await domainRow(c.env, name)).relay_key!,
				"relay:" + name,
			);
	}
	const origin = new URL(c.req.url).origin;
	if (b.action === "credentials") {
		await audit(c.env, c.var.principal, "domain.relay-credentials", name);
		return c.json({
			endpoint: `${origin}/ingress/email/${name}`,
			secret,
			protocol:
				"HMAC-SHA256: timestamp + LF + requestId + LF + envelopeFrom + LF + envelopeTo + LF + SHA256(raw MIME), X-Inbox-Time / Id / From / To / Signature。5 分钟内有效；相同 requestId 幂等。",
			source: relaySource(),
		});
	}
	const account = await connection(c.env, row.connection_id);
	if (
		!account ||
		account.provider !== "cloudflare" ||
		!c.env.INBOX_ACCOUNT_ID ||
		account.account_id === c.env.INBOX_ACCOUNT_ID
	)
		throw new HTTPException(400, {
			message: "请选择其他 Cloudflare 账户连接，主账户无需部署接入 Worker",
		});
	const worker = `inbox-relay-${(await digest(name)).slice(0, 12)}`;
	try {
		const current = await provider(
			c.env,
			account,
			`/accounts/${account.account_id}/workers/scripts/${worker}/settings`,
		);
		if (
			!current.tags?.includes("agentic-inbox-domain-relay") ||
			!current.bindings?.some(
				(x: any) =>
					x.name === "INBOX_MAIN_WORKER" && x.text === c.env.INBOX_WORKER_NAME,
			) ||
			!current.bindings?.some(
				(x: any) =>
					x.name === "INBOX_MAIN_ACCOUNT" && x.text === c.env.INBOX_ACCOUNT_ID,
			) ||
			!current.bindings?.some(
				(x: any) => x.name === "INBOX_DOMAIN" && x.text === name,
			)
		)
			throw new HTTPException(409, {
				message: "同名 Worker 不属于此接入配置，禁止覆盖",
			});
	} catch (e) {
		if (!(e instanceof ProviderError && e.status === 404)) throw e;
	}
	const form = new FormData();
	form.set(
		"metadata",
		JSON.stringify({
			main_module: "relay.mjs",
			compatibility_date: "2025-11-28",
			tags: ["agentic-inbox-domain-relay"],
			bindings: [
				{ name: "INBOX_DOMAIN", type: "plain_text", text: name },
				{ name: "INBOX_ORIGIN", type: "plain_text", text: origin },
				{
					name: "INBOX_MAIN_ACCOUNT",
					type: "plain_text",
					text: c.env.INBOX_ACCOUNT_ID,
				},
				{
					name: "INBOX_MAIN_WORKER",
					type: "plain_text",
					text: c.env.INBOX_WORKER_NAME,
				},
				{ name: "BRIDGE_KEY", type: "secret_text", text: secret },
			],
		}),
	);
	form.set(
		"relay.mjs",
		new Blob([relaySource()], { type: "application/javascript+module" }),
		"relay.mjs",
	);
	try {
		await provider(
			c.env,
			account,
			`/accounts/${account.account_id}/workers/scripts/${worker}`,
			"PUT",
			form,
		);
	} catch {
		throw new HTTPException(502, {
			message: "接入 Worker 部署失败，请检查该账户 Workers Scripts 编辑权限",
		});
	}
	await audit(c.env, c.var.principal, "domain.relay-deploy", name, {
		worker,
		accountId: account.account_id,
	});
	return c.json({ ok: true, worker });
});
domainApp.post(base + "/probe", async (c) => {
	const name = normalizeDomain(c.req.param("domain")!);
	await domainRow(c.env, name);
	await rateLimit(c.env, "domain-probe:" + name, 10, 3600);
	const address = `inbox-check-${crypto.randomUUID().replace(/-/g, "")}@${name}`;
	const expires = Math.floor(Date.now() / 1000) + 1800;
	await directory(c.env).batch([
		directory(c.env)
			.prepare("DELETE FROM domain_probes WHERE expires_at<?")
			.bind(Math.floor(Date.now() / 1000)),
		directory(c.env)
			.prepare(
				"INSERT INTO domain_probes(address,domain,expires_at) VALUES (?,?,?)",
			)
			.bind(address, name, expires),
	]);
	return c.json({ address, expiresAt: expires });
});
domainApp.get(base + "/probe", async (c) => {
	const name = normalizeDomain(c.req.param("domain")!);
	const r = await directory(c.env)
		.prepare(
			"SELECT address,expires_at,received_at FROM domain_probes WHERE domain=? AND expires_at>? ORDER BY expires_at DESC LIMIT 1",
		)
		.bind(name, Math.floor(Date.now() / 1000))
		.first();
	return c.json(r);
});
domainApp.post(base + "/test-send", async (c) => {
	const name = normalizeDomain(c.req.param("domain")!);
	const b = z
		.object({ from: z.string().email(), to: z.string().email() })
		.parse(await c.req.json());
	if (b.from.split("@")[1].toLowerCase() !== name)
		throw new HTTPException(400, { message: "发件地址不属于该域名" });
	const alias = await directory(c.env)
		.prepare("SELECT mailbox_address FROM mailbox_addresses WHERE address=?")
		.bind(b.from.toLowerCase())
		.first<{ mailbox_address: string }>();
	if (!alias)
		throw new HTTPException(400, { message: "请先创建此域名下的邮箱地址" });
	await assertSender(c.env, alias.mailbox_address, b.from.toLowerCase());
	await rateLimit(c.env, "domain-test-send:" + name, 5, 3600);
	await consumeQuota(c.env, c.var.principal, "send");
	try {
		const r = await sendEmail(c.env, {
			from: b.from,
			to: b.to,
			subject: `[Inbox] ${name} 发信配置测试`,
			text: "这是管理员主动发出的配置测试邮件。请在收件方确认收到，并检查邮件头 SPF/DKIM/DMARC 结果。",
		});
		await audit(c.env, c.var.principal, "domain.test-send", name);
		return c.json({
			messageId: r.messageId,
			note: "发信服务已接受，请在收件箱确认投递和认证结果。",
		});
	} catch {
		throw new HTTPException(502, {
			message: "测试发送失败，请检查域名状态和服务授权；不会自动重试发送",
		});
	}
});
