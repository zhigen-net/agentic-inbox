import { Button, Dialog, Input } from "@cloudflare/kumo";
import { GlobeIcon, PlusIcon, ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useState } from "react";
import api, { type Domain } from "~/services/api";
import type { RunAction } from "~/routes/team";
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
	const list = domains.filter((d) => d.name.includes(search.toLowerCase()));
	return (
		<>
			<div className="portal-toolbar">
				<SearchField
					value={search}
					onChange={setSearch}
					placeholder="搜索域名…"
				/>
				<Button
					variant="primary"
					icon={<PlusIcon size={16} />}
					onClick={() => setOpen(true)}
				>
					添加域名
				</Button>
			</div>
			<div className="space-y-4">
				{list.map((d) => (
					<DomainCard
						key={`${d.name}-${d.enabled}-${d.receive_enabled}-${d.send_enabled}-${d.checked_at}`}
						domain={d}
						busy={busy}
						run={run}
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
		</>
	);
}
function DomainCard({
	domain: d,
	busy,
	run,
}: {
	domain: Domain;
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
	return (
		<section className="portal-panel">
			<div className="portal-panel-heading">
				<div className="flex items-center gap-3">
					<span className="portal-stat-icon">
						<GlobeIcon size={21} />
					</span>
					<div>
						<h2>{d.name}</h2>
						<p>
							{d.checked_at
								? d.mx_verified
									? "已检测到 Cloudflare MX 记录"
									: "尚未检测到 Cloudflare MX 记录"
								: "尚未检测邮件路由"}
						</p>
					</div>
				</div>
				<StatusPill tone={d.enabled ? "green" : "neutral"}>
					{d.enabled ? "已启用" : "已停用"}
				</StatusPill>
			</div>
			<div className="portal-panel-body">
				<div className="grid sm:grid-cols-3 gap-4">
					<label className="portal-checkbox">
						<input
							type="checkbox"
							checked={enabled}
							onChange={(e) => setEnabled(e.target.checked)}
							disabled={busy}
						/>
						启用此域名
					</label>
					<label className="portal-checkbox">
						<input
							type="checkbox"
							checked={receive}
							onChange={(e) => setReceive(e.target.checked)}
							disabled={busy}
						/>
						允许收信
					</label>
					<label className="portal-checkbox">
						<input
							type="checkbox"
							checked={send}
							onChange={(e) => setSend(e.target.checked)}
							disabled={busy}
						/>
						允许发信
					</label>
				</div>
				<div className="flex flex-wrap gap-3 justify-between items-center border-t border-kumo-line pt-4 mt-5">
					<p className="portal-section-help max-w-md">
						启用发信前，请先在 Cloudflare 完成验证。MX 检测仅检查收信路由。
					</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							variant="secondary"
							icon={<ArrowClockwiseIcon size={14} />}
							disabled={busy}
							onClick={() =>
								void run(() => api.checkDomain(d.name), "MX 检测已更新")
							}
						>
							检测 MX
						</Button>
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
									"域名设置已保存",
								)
							}
						>
							保存设置
						</Button>
					</div>
				</div>
			</div>
		</section>
	);
}
