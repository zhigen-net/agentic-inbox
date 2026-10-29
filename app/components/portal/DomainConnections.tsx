import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import api from "~/services/api";
import { Notice, StatusPill } from "./PortalShell";
export default function DomainConnections({ close }: { close: () => void }) {
	const q = useQuery({
			queryKey: ["domain-connections"],
			queryFn: api.domainConnections,
		}),
		qc = useQueryClient();
	const [name, setName] = useState(""),
		[provider, setProvider] = useState<"cloudflare" | "resend">("cloudflare"),
		[account, setAccount] = useState(""),
		[token, setToken] = useState(""),
		[busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[rotate, setRotate] = useState("");
	async function action(fn: () => Promise<unknown>) {
		setBusy(true);
		setError("");
		try {
			await fn();
			await qc.invalidateQueries({ queryKey: ["domain-connections"] });
			setToken("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "操作失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog.Root open onOpenChange={(v) => !v && !busy && close()}>
			<Dialog size="lg" className="portal-dialog domain-wizard">
				<div className="portal-dialog-heading">
					<Dialog.Title className="text-lg font-semibold">
						服务连接与授权
					</Dialog.Title>
					<p className="portal-section-help">
						按账户保存独立授权。令牌加密保存在服务端，不会回显。
					</p>
				</div>
				<div className="portal-dialog-body space-y-5">
					{(error || q.error) && (
						<Notice error>{error || q.error?.message}</Notice>
					)}
					{q.data && !q.data.encryptionReady && (
						<Notice error>服务端加密密钥尚未配置，暂不能保存连接。</Notice>
					)}
					<div className="space-y-3">
						{q.data?.connections.map((c) => (
							<div
								className="rounded-lg border border-kumo-line p-3"
								key={c.id}
							>
								<div className="flex justify-between gap-3 items-center">
									<div className="min-w-0">
										<p className="text-xs font-medium truncate">{c.name}</p>
										<p className="text-[11px] text-kumo-subtle break-all mt-1">
											{c.provider === "cloudflare" ? c.account_id : "Resend"}
										</p>
									</div>
									<StatusPill>
										{c.provider === "cloudflare" ? "Cloudflare" : "Resend"}
									</StatusPill>
								</div>
								<div className="flex gap-2 mt-3">
									<Button
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => {
											setRotate(rotate === c.id ? "" : c.id);
											setToken("");
										}}
									>
										更新令牌
									</Button>
									<Button
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => {
											if (
												window.confirm(
													"删除这个服务连接？仍被域名绑定时将拒绝删除。",
												)
											)
												void action(() => api.deleteDomainConnection(c.id));
										}}
									>
										删除
									</Button>
								</div>
								{rotate === c.id && (
									<form
										className="mt-3 space-y-3"
										onSubmit={(e) => {
											e.preventDefault();
											void action(() =>
												api.rotateDomainConnection(c.id, token),
											).then(() => setRotate(""));
										}}
									>
										<Input
											label="新令牌"
											type="password"
											autoComplete="off"
											value={token}
											minLength={16}
											onChange={(e) => setToken(e.target.value)}
											required
										/>
										<Button type="submit" size="sm" disabled={busy}>
											更新
										</Button>
									</form>
								)}
							</div>
						))}
					</div>
					{!rotate && (
						<form
							className="border-t border-kumo-line pt-5 space-y-4"
							onSubmit={(e) => {
								e.preventDefault();
								void action(async () => {
									await api.createDomainConnection({
										name,
										provider,
										accountId: provider === "cloudflare" ? account : undefined,
										token,
									});
									setName("");
									setAccount("");
								});
							}}
						>
							<h3 className="portal-section-title">新增连接</h3>
							<Input
								label="连接名称"
								placeholder="例如：主账户 / 品牌账户"
								value={name}
								maxLength={80}
								onChange={(e) => setName(e.target.value)}
								required
							/>
							<label className="portal-label">
								服务商
								<select
									className="portal-select"
									value={provider}
									onChange={(e) => {
										setProvider(e.target.value as "cloudflare" | "resend");
										setToken("");
									}}
								>
									<option value="cloudflare">
										Cloudflare（收信配置与发信）
									</option>
									<option value="resend">Resend（外部 DNS 发信）</option>
								</select>
							</label>
							{provider === "cloudflare" && (
								<Input
									label="Cloudflare 账户 ID"
									value={account}
									pattern="[a-f0-9]{32}"
									onChange={(e) => setAccount(e.target.value.trim())}
									required
								/>
							)}
							<Input
								label="API 令牌"
								type="password"
								autoComplete="off"
								minLength={16}
								maxLength={4096}
								value={token}
								onChange={(e) => setToken(e.target.value)}
								required
							/>
							<Button
								type="submit"
								variant="primary"
								disabled={busy || !q.data?.encryptionReady}
							>
								{busy ? "保存中…" : "保存连接"}
							</Button>
						</form>
					)}
					<details className="text-xs text-kumo-subtle leading-7">
						<summary className="cursor-pointer font-medium">
							需要授予哪些权限？
						</summary>
						<p className="mt-2">
							Cloudflare 只选择所需账户与域名。检查需要 Zone 读取、Email Routing
							规则/设置读取、Email Sending 读取；自动配置还需 DNS 编辑、Email
							Routing 规则/设置编辑、Email Sending 编辑。跨账户自动部署接入
							Worker 另需该账户 Workers Scripts 编辑。权限名称以 Cloudflare
							令牌页面为准；不足时检测会明确显示。
						</p>
						<p className="mt-2">
							Resend
							域名检查需域名读取权限，发送需邮件发送权限。令牌权限变更后，请重新检测。不要在聊天或
							URL 中传递令牌。
						</p>
					</details>
				</div>
				<div className="portal-dialog-footer">
					<Button variant="secondary" onClick={close} disabled={busy}>
						完成
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
