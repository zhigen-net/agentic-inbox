import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import api, { type TeamUser, type Domain } from "~/services/api";
import type { RunAction } from "~/routes/team";
import { Notice, StatusPill } from "./PortalShell";
export default function UserDetails({
	user,
	domains,
	meId,
	busy,
	run,
	error,
	close,
	showLink,
}: {
	user: TeamUser;
	domains: Domain[];
	meId: string;
	busy: boolean;
	run: RunAction;
	error: string;
	close: () => void;
	showLink: (url: string, title: string, description: string) => void;
}) {
	const permissions = useQuery({
		queryKey: ["permissions", user.id],
		queryFn: () => api.getUserPermissions(user.id),
	});
	const [canCreate, setCanCreate] = useState(!!user.can_create_mailboxes),
		[limit, setLimit] = useState(user.mailbox_limit ?? 3),
		[sendLimit, setSendLimit] = useState(user.send_limit ?? 100),
		[aiLimit, setAiLimit] = useState(user.ai_limit ?? 50),
		[selected, setSelected] = useState<string[] | null>(null);
	const values = selected ?? permissions.data?.domains ?? [];
	return (
		<Dialog.Root open onOpenChange={(v) => !v && !busy && close()}>
			<Dialog size="sm" className="portal-dialog">
				<div className="portal-dialog-heading">
					<Dialog.Title className="text-lg font-semibold">
						成员设置
					</Dialog.Title>
					<div className="mt-3 flex items-center gap-2 flex-wrap">
						<span className="text-xs text-kumo-subtle break-all">
							{user.email}
						</span>
						<StatusPill
							tone={
								user.status === "pending"
									? "amber"
									: user.active
										? "green"
										: "neutral"
							}
						>
							{user.status === "pending"
								? "待审核"
								: user.active
									? "已启用"
									: "已停用"}
						</StatusPill>
					</div>
				</div>
				<form
					onSubmit={async (e) => {
						e.preventDefault();
						const ok = await run(
							() =>
								api.setUserPermissions(user.id, {
									canCreate,
									mailboxLimit: limit,
									sendLimit,
									aiLimit,
									domains: values,
								}),
							"成员权限已更新",
						);
						if (ok) close();
					}}
				>
					<div className="portal-dialog-body space-y-6">
						{error && <Notice error>{error}</Notice>}
						{permissions.error && (
							<Notice error>{permissions.error.message}</Notice>
						)}
						<section>
							<h3 className="portal-section-title mb-3">邮箱创建权限</h3>
							<label className="portal-choice">
								<input
									type="checkbox"
									checked={canCreate}
									onChange={(e) => setCanCreate(e.target.checked)}
								/>
								<div>
									<span>允许自行创建邮箱</span>
									<p className="portal-section-help">
										关闭后仍可访问管理员分配的邮箱。
									</p>
								</div>
							</label>
						</section>
						<fieldset
							disabled={
								!canCreate || permissions.isLoading || !!permissions.error
							}
							className="space-y-4 disabled:opacity-50"
						>
							<Input
								label="自建邮箱上限"
								type="number"
								min={0}
								max={1000}
								value={String(limit)}
								onChange={(e) => setLimit(Number(e.target.value))}
								required
							/>
							<div>
								<p className="text-xs font-medium mb-2.5">可用域名</p>
								<div className="grid gap-2 max-h-40 overflow-y-auto">
									{domains
										.filter((d) => d.enabled)
										.map((d) => (
											<label className="portal-choice" key={d.name}>
												<input
													type="checkbox"
													checked={values.includes(d.name)}
													onChange={() =>
														setSelected(
															values.includes(d.name)
																? values.filter((x) => x !== d.name)
																: [...values, d.name],
														)
													}
												/>
												{d.name}
											</label>
										))}
								</div>
								{!domains.some((d) => d.enabled) && (
									<p className="portal-section-help">暂无启用的域名。</p>
								)}
							</div>
						</fieldset>
						<section className="border-t border-kumo-line pt-5">
							<h3 className="portal-section-title mb-4">每日使用额度</h3>
							<div className="grid grid-cols-2 gap-4">
								<Input
									label="发信尝试次数"
									type="number"
									min={0}
									max={10000}
									value={String(sendLimit)}
									onChange={(e) => setSendLimit(Number(e.target.value))}
									required
								/>
								<Input
									label="AI 操作次数"
									type="number"
									min={0}
									max={10000}
									value={String(aiLimit)}
									onChange={(e) => setAiLimit(Number(e.target.value))}
									required
								/>
							</div>
							<p className="portal-section-help mt-3">
								设为 0 即关闭相应功能。每日按 UTC
								重置；管理员分配的邮箱不占自建额度。
							</p>
						</section>
						<section className="border-t border-kumo-line pt-5">
							<h3 className="portal-section-title mb-4">账号管理</h3>
							<div className="flex flex-wrap gap-2">
								<Button
									type="button"
									variant="secondary"
									size="sm"
									disabled={busy || !user.active}
									onClick={() =>
										void run(async () => {
											const r = await api.resetLink(user.id);
											close();
											showLink(
												r.url,
												"密码重置链接",
												"1 小时内有效，请私下交给该成员。",
											);
										}, "重置链接已生成")
									}
								>
									生成重置链接
								</Button>
								<Button
									type="button"
									variant="secondary"
									size="sm"
									disabled={busy || user.id === meId}
									onClick={() => {
										if (
											window.confirm(
												`确认将 ${user.email} ${user.role === "admin" ? "设为成员" : "设为管理员"}？`,
											)
										)
											void run(
												() =>
													api.updateUser(
														user.id,
														user.role === "admin" ? "member" : "admin",
														!!user.active,
													),
												"用户角色已更新",
											);
									}}
								>
									{user.role === "admin" ? "设为成员" : "设为管理员"}
								</Button>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									disabled={busy || user.id === meId}
									onClick={() => {
										if (
											!user.active ||
											user.status === "pending" ||
											window.confirm("停用后该成员将无法登录。确认停用？")
										)
											void run(
												() =>
													api.updateUser(
														user.id,
														user.role,
														user.status === "pending" ? true : !user.active,
													),
												"账号状态已更新",
											);
									}}
								>
									{user.status === "pending"
										? "批准加入"
										: user.active
											? "停用账号"
											: "启用账号"}
								</Button>
							</div>
						</section>
					</div>
					<div className="portal-dialog-footer">
						<Button
							type="button"
							variant="secondary"
							onClick={close}
							disabled={busy}
						>
							取消
						</Button>
						<Button
							type="submit"
							variant="primary"
							disabled={busy || permissions.isLoading || !!permissions.error}
						>
							{busy ? "保存中…" : "保存权限"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
