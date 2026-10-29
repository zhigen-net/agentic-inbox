import { Button, Input } from "@cloudflare/kumo";
import { useState, type FormEvent } from "react";
import {
	ShieldCheckIcon,
	LockKeyIcon,
	EnvelopeSimpleIcon,
} from "@phosphor-icons/react";
import PortalShell, {
	PageHeading,
	StatusPill,
	Notice,
} from "~/components/portal/PortalShell";
import { useQuery } from "@tanstack/react-query";
import api from "~/services/api";
export default function Account() {
	const q = useQuery({ queryKey: ["auth-config"], queryFn: api.authConfig });
	const [password, setPassword] = useState(""),
		[current, setCurrent] = useState(""),
		[confirmation, setConfirmation] = useState(""),
		[message, setMessage] = useState(""),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false);

	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError("");
		setMessage("");
		try {
			if (password !== confirmation) throw new Error("两次密码不一致");
			await api.changePassword(password, current);
			setPassword("");
			setCurrent("");
			setConfirmation("");
			setMessage("密码已更新，其它登录会话已退出");
			await q.refetch();
		} catch (e) {
			setError(e instanceof Error ? e.message : "操作失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<PortalShell>
			<PageHeading
				eyebrow="ACCOUNT & SECURITY"
				title="账号与安全"
				description="管理你的登录身份，让每次访问都安心。"
			/>
			<div className="portal-security-grid">
				<section className="portal-panel">
					<div className="portal-panel-heading">
						<div className="flex items-center gap-3">
							<LockKeyIcon size={20} className="text-kumo-subtle" />
							<div>
								<h2>
									{q.data?.user?.hasPassword ? "修改登录密码" : "设置登录密码"}
								</h2>
								<p>更新密码后，其他设备的登录会话将退出。</p>
							</div>
						</div>
					</div>
					<div className="portal-panel-body">
						{q.error && <Notice error>{q.error.message}</Notice>}
						{error && <Notice error>{error}</Notice>}
						{message && <Notice>{message}</Notice>}
						{q.data?.user && !q.data.user.hasPassword && (
							<Notice>
								你正在通过 Access 登录。设置独立密码后，即可使用邮箱与密码登录。
							</Notice>
						)}
						<form onSubmit={submit} className="space-y-5 max-w-sm">
							{q.data?.user?.hasPassword && (
								<Input
									label="当前密码"
									type="password"
									autoComplete="current-password"
									value={current}
									onChange={(e) => setCurrent(e.target.value)}
									required
								/>
							)}
							<Input
								label="新密码"
								placeholder="至少 12 位字符"
								type="password"
								autoComplete="new-password"
								minLength={12}
								maxLength={128}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
							/>
							<Input
								label="确认新密码"
								type="password"
								autoComplete="new-password"
								value={confirmation}
								onChange={(e) => setConfirmation(e.target.value)}
								required
							/>
							<p className="portal-section-help">
								建议使用与其他网站不同的长密码。
							</p>
							<Button
								type="submit"
								variant="primary"
								disabled={busy || q.isLoading || !!q.error}
							>
								{busy ? "保存中…" : "更新密码"}
							</Button>
						</form>
					</div>
				</section>
				<div className="space-y-5">
					<section className="portal-panel">
						<div className="portal-panel-heading">
							<h2>登录身份</h2>
							<EnvelopeSimpleIcon size={18} className="text-kumo-subtle" />
						</div>
						<div className="portal-panel-body">
							<p className="text-xs text-kumo-subtle mb-2">登录邮箱</p>
							<p className="text-sm font-medium break-all">
								{q.data?.user?.email}
							</p>
							<div className="mt-4">
								<StatusPill>
									{q.data?.user?.role === "admin"
										? "工作空间管理员"
										: "团队成员"}
								</StatusPill>
							</div>
							<p className="portal-section-help mt-5">
								登录账号用于访问工作空间，可管理多个收发邮箱。
							</p>
						</div>
					</section>
					<section className="portal-panel">
						<div className="portal-panel-body">
							<ShieldCheckIcon size={24} className="text-kumo-subtle mb-4" />
							<h2 className="portal-section-title">安全提示</h2>
							<p className="portal-section-help mt-2">
								如果需要找回密码，请联系管理员获取一次性重置链接。
							</p>
							<p className="portal-section-help mt-3">
								在公共设备使用完毕后，记得退出登录。
							</p>
							<Button
								variant="secondary"
								className="mt-5"
								disabled={busy}
								onClick={async () => {
									setBusy(true);
									try {
										await api.logout();
										window.location.assign("/login");
									} catch (e) {
										setError(e instanceof Error ? e.message : "退出失败");
										setBusy(false);
									}
								}}
							>
								退出当前账号
							</Button>
						</div>
					</section>
				</div>
			</div>
		</PortalShell>
	);
}
