import { Button, Dialog, Input } from "@cloudflare/kumo";
import { GlobeIcon, PlusIcon } from "@phosphor-icons/react";
import { useState } from "react";
import api, { type Domain } from "~/services/api";
import type { RunAction } from "~/routes/team";
import DomainWizard from "./DomainWizard";
import DomainConnections from "./DomainConnections";
import type { DomainHealth } from "../../../shared/domain-health";
import { EmptyState, StatusPill, SearchField } from "./PortalShell";
export default function DomainManagement({
	domains,
	loading,
	busy,
	run,
}: {
	domains: Domain[];
	loading: boolean;
	busy: boolean;
	run: RunAction;
}) {
	const [open, setOpen] = useState(false),
		[name, setName] = useState(""),
		[search, setSearch] = useState(""),
		[localError, setLocalError] = useState("");
	const [inspected, setInspected] = useState<Domain | null>(null),
		[connections, setConnections] = useState(false);
	const list = domains.filter((d) => d.name.includes(search.toLowerCase()));
	return (
		<>
			<div className="portal-toolbar">
				<SearchField
					value={search}
					onChange={setSearch}
					placeholder="搜索域名…"
				/>
				<div className="flex flex-wrap gap-2">
					<Button variant="secondary" onClick={() => setConnections(true)}>
						服务连接
					</Button>
					<Button
						variant="secondary"
						disabled={busy || !domains.length}
						onClick={() =>
							void run(async () => {
								for (const d of domains) await api.domainHealth(d.name);
							}, "域名检测已完成，请查看各项状态")
						}
					>
						检测全部
					</Button>
					<Button
						variant="primary"
						icon={<PlusIcon size={16} />}
						onClick={() => setOpen(true)}
					>
						添加域名
					</Button>
				</div>
			</div>
			<div className="space-y-2">
				{list.map((d) => (
					<DomainCard
						key={`${d.name}-${d.enabled}-${d.receive_enabled}-${d.send_enabled}-${d.checked_at}`}
						domain={d}
						busy={busy}
						run={run}
						inspect={() => setInspected(d)}
					/>
				))}
				{loading ? (
					<p className="p-6 text-xs text-kumo-subtle">正在加载域名…</p>
				) : (
					!list.length && (
						<div className="portal-panel">
							<EmptyState
								title={search ? "没有匹配的域名" : "连接你的第一个域名"}
								description="添加域名并配置邮件路由后，就可以用它创建邮箱地址。"
							/>
						</div>
					)
				)}
			</div>
			<p className="portal-section-help mt-5">
				新增域名不会自动改变现有邮箱。你可以在邮箱管理中为指定邮箱追加地址。
			</p>
			<Dialog.Root open={open} onOpenChange={(v) => !busy && setOpen(v)}>
				<Dialog size="sm" className="portal-dialog">
					<div className="portal-dialog-heading">
						<Dialog.Title className="text-lg font-semibold">
							添加邮件域名
						</Dialog.Title>
						<p className="portal-section-help">
							添加后，在 Cloudflare 完成邮件路由和发信验证。
						</p>
					</div>
					<form
						onSubmit={async (e) => {
							e.preventDefault();
							setLocalError("");
							const ok = await run(
								() => api.addDomain(name),
								"域名已添加，请继续配置收发能力",
							);
							if (ok) {
								setOpen(false);
								setInspected({
									name,
									enabled: 1,
									receive_enabled: 0,
									send_enabled: 0,
									mx_verified: 0,
								});
								setName("");
							} else setLocalError("添加失败，请检查域名是否有效或已存在。");
						}}
					>
						<div className="portal-dialog-body">
							<Input
								label="域名"
								placeholder="example.com"
								value={name}
								onChange={(e) => setName(e.target.value.trim().toLowerCase())}
								required
							/>
							<p className="portal-section-help mt-3">
								填写完整域名，无需 https:// 或 @ 前缀。
							</p>
							{localError && (
								<p role="alert" className="text-kumo-error text-xs mt-3">
									{localError}
								</p>
							)}
						</div>
						<div className="portal-dialog-footer">
							<Button
								type="button"
								variant="secondary"
								disabled={busy}
								onClick={() => setOpen(false)}
							>
								取消
							</Button>
							<Button type="submit" variant="primary" disabled={busy}>
								{busy ? "添加中…" : "添加域名"}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
			{inspected && (
				<DomainWizard
					key={inspected.name}
					domain={domains.find((d) => d.name === inspected.name) || inspected}
					close={() => setInspected(null)}
				/>
			)}
			{connections && <DomainConnections close={() => setConnections(false)} />}
		</>
	);
}
function DomainCard({
	domain: d,
	busy,
	run,
	inspect,
}: {
	domain: Domain;
	inspect: () => void;
	busy: boolean;
	run: RunAction;
}) {
	const [enabled, setEnabled] = useState(!!d.enabled),
		[receive, setReceive] = useState(!!d.receive_enabled),
		[send, setSend] = useState(!!d.send_enabled);
	const dirty =
		enabled !== !!d.enabled ||
		receive !== !!d.receive_enabled ||
		send !== !!d.send_enabled;
	let health: DomainHealth | null = null;
	try {
		health = d.health_json ? JSON.parse(d.health_json) : null;
	} catch {
		/* An obsolete report must not break the management page. */
	}
	const attention =
		health?.checks.filter((x) =>
			["missing", "permission", "error", "warning"].includes(x.state),
		).length || 0;
	const unknown =
		health?.checks.filter((x) => x.state === "unknown").length || 0;
	return (
		<section className="portal-panel compact-domain-card">
			<div className="compact-domain-row">
				<div className="flex items-center gap-3 min-w-0">
					<GlobeIcon size={20} className="text-kumo-subtle shrink-0" />
					<div className="min-w-0">
						<div className="flex items-center flex-wrap gap-2">
							<h2 className="text-sm font-semibold break-all">{d.name}</h2>
							<StatusPill tone={d.enabled ? "green" : "neutral"}>
								{d.enabled ? "已启用" : "已停用"}
							</StatusPill>
						</div>
						<p className="text-[11px] text-kumo-subtle mt-1">
							收信{d.receive_enabled ? "允许" : "关闭"} · 发信
							{d.send_enabled ? "允许" : "关闭"}
							<span className="mx-2">·</span>
							{health
								? `检测于 ${new Date(health.checkedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`
								: "尚未完整检测"}
						</p>
					</div>
				</div>
				<div className="compact-domain-actions">
					{health ? (
						<span className="text-xs text-kumo-subtle">
							{attention
								? `${attention} 项待处理`
								: unknown
									? "暂无已确认异常"
									: "配置检查已通过"}
							{unknown ? ` · ${unknown} 项未验证` : ""}
						</span>
					) : (
						<span className="text-xs text-kumo-subtle">状态待检查</span>
					)}
					<Button variant="secondary" size="sm" onClick={inspect}>
						检查与配置
					</Button>
				</div>
			</div>
			<details className="compact-domain-switches">
				<summary>使用开关{dirty ? " · 未保存" : ""}</summary>
				<div className="flex flex-wrap items-center gap-x-6 gap-y-3 mt-3">
					{[
						[enabled, setEnabled, "启用域名"],
						[receive, setReceive, "允许收信"],
						[send, setSend, "允许发信"],
					].map(([value, set, label]) => (
						<label className="portal-checkbox" key={label as string}>
							<input
								type="checkbox"
								checked={value as boolean}
								disabled={busy}
								onChange={(e) =>
									(set as (v: boolean) => void)(e.target.checked)
								}
							/>
							{label as string}
						</label>
					))}
					<Button
						size="sm"
						variant="primary"
						disabled={busy || !dirty}
						onClick={() =>
							void run(
								() =>
									api.updateDomain(d.name, {
										enabled,
										receiveEnabled: receive,
										sendEnabled: send,
									}),
								"域名开关已保存",
							)
						}
					>
						保存开关
					</Button>
				</div>
				<p className="portal-section-help mt-2">
					仅控制系统使用，不代表 DNS 或实际收发已验证。
				</p>
			</details>
		</section>
	);
}
