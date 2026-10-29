import { Button, Input } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import api from "~/services/api";
import {
	EnvelopeSimpleIcon,
	CheckCircleIcon,
	ArrowRightIcon,
} from "@phosphor-icons/react";
import { Brand, Notice } from "~/components/portal/PortalShell";
export default function AccountForm({
	mode,
}: {
	mode: "login" | "register" | "reset" | "setup";
}) {
	const params =
		typeof window !== "undefined"
			? new URLSearchParams(
					window.location.hash.slice(1) || window.location.search.slice(1),
				)
			: new URLSearchParams();
	const config = useQuery({
		queryKey: ["auth-config"],
		queryFn: api.authConfig,
	});
	const [setupToken, setSetupToken] = useState("");
	const [email, setEmail] = useState(params.get("email") || ""),
		[password, setPassword] = useState(""),
		[confirmation, setConfirmation] = useState("");
	const [error, setError] = useState(""),
		[message, setMessage] = useState(""),
		[busy, setBusy] = useState(false);
	const navigate = useNavigate(),
		qc = useQueryClient();
	async function submit(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError("");
		try {
			if (mode !== "login" && password !== confirmation)
				throw new Error("两次密码不一致");
			if (mode === "setup") await api.bootstrap(email, password, setupToken);
			else if (mode === "login") await api.login(email, password);
			else if (mode === "reset") {
				await api.resetPassword(params.get("token") || "", password);
				setMessage("密码已重置，请登录");
				setPassword("");
				return;
			} else {
				const result = await api.register(
					email,
					password,
					params.get("token") || undefined,
				);
				if (result.pending) {
					setMessage("注册申请已提交，请等待管理员审核");
					return;
				}
			}
			qc.clear();
			navigate("/", { replace: true });
		} catch (e) {
			setError(e instanceof Error ? e.message : "操作失败");
		} finally {
			setBusy(false);
		}
	}
	const title =
		mode === "login"
			? "欢迎回来"
			: mode === "register"
				? params.get("token")
					? "加入你的团队"
					: "创建账号"
				: mode === "setup"
					? "创建管理账号"
					: "设置新密码";
	return (
		<main className="auth-page">
			<aside className="auth-aside">
				<Brand />
				<div className="auth-aside-content">
					<p className="portal-eyebrow">A QUIETER WAY TO EMAIL</p>
					<h2>
						让邮件有序，
						<br />
						让工作从容。
					</h2>
					<p>
						一个工作空间，连接你的所有邮箱。
						<br />
						把精力留给真正重要的事。
					</p>
					<div className="auth-illustration" aria-hidden="true">
						<div className="flex justify-between items-center mb-5">
							<EnvelopeSimpleIcon size={22} className="text-kumo-subtle" />
							<span className="w-2 h-2 rounded-full bg-orange-400" />
						</div>
						<div className="h-2 w-2/3 bg-kumo-fill rounded mb-3" />
						<div className="h-1.5 w-full bg-kumo-tint rounded mb-2" />
						<div className="h-1.5 w-4/5 bg-kumo-tint rounded" />
						<div className="flex gap-2 items-center mt-7 border-t border-kumo-line pt-4 text-[10px] text-kumo-subtle">
							<CheckCircleIcon size={14} />
							每一封邮件，都有归处
						</div>
					</div>
				</div>
				<p className="auth-aside-footer text-[10px] text-kumo-subtle">
					YOUR MAIL. YOUR WORKSPACE.
				</p>
			</aside>
			<div className="auth-main">
				<div className="auth-form">
					<h1>{title}</h1>
					<p className="auth-form-subtitle">
						{mode === "login"
							? "登录工作空间，继续处理你的邮件。"
							: mode === "register"
								? "使用登录邮箱建立账号，加入团队工作空间。"
								: mode === "setup"
									? "设置管理员身份，开启团队邮件工作空间。"
									: "为你的账号设置一个新的安全密码。"}
					</p>
					{mode === "register" && !params.get("token") && (
						<Notice>
							{config.data?.registrationMode === "approval"
								? "注册申请需经管理员审核，批准后可登录。"
								: "当前仅接受邀请，请向管理员获取邀请链接。"}
						</Notice>
					)}
					{config.error && (
						<Notice error>暂时无法获取登录配置，请刷新重试。</Notice>
					)}
					{error && <Notice error>{error}</Notice>}
					{message && <Notice>{message}</Notice>}
					{!message && (
						<form onSubmit={submit} className="space-y-5">
							{mode !== "reset" && (
								<Input
									label="登录邮箱"
									placeholder="name@example.com"
									type="email"
									autoComplete="username"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									required
								/>
							)}
							{mode === "setup" && (
								<Input
									label="管理员初始化凭据"
									type="password"
									autoComplete="off"
									minLength={32}
									value={setupToken}
									onChange={(e) => setSetupToken(e.target.value)}
									required
								/>
							)}
							<Input
								label={mode === "login" ? "密码" : "密码（至少 12 位）"}
								type="password"
								autoComplete={
									mode === "login" ? "current-password" : "new-password"
								}
								minLength={mode === "login" ? 1 : 12}
								maxLength={128}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
							/>
							{mode !== "login" && (
								<Input
									label="确认密码"
									type="password"
									autoComplete="new-password"
									value={confirmation}
									onChange={(e) => setConfirmation(e.target.value)}
									required
								/>
							)}
							<Button
								type="submit"
								variant="primary"
								className="w-full mt-2"
								disabled={
									busy ||
									(mode === "register" &&
										!params.get("token") &&
										config.data?.registrationMode !== "approval")
								}
							>
								{busy
									? "处理中…"
									: mode === "login"
										? "登录工作空间"
										: mode === "register"
											? "创建账号"
											: "设置密码"}
							</Button>
						</form>
					)}
					<div className="mt-7 text-center text-xs text-kumo-subtle">
						{mode === "login" ? (
							<>
								还没有账号？
								<Link
									to="/register"
									className="text-kumo-default ml-1 font-medium hover:underline"
								>
									加入工作空间
								</Link>
							</>
						) : (
							<>
								已有账号？
								<Link
									to="/login"
									className="text-kumo-default ml-1 font-medium hover:underline"
								>
									返回登录
								</Link>
							</>
						)}
					</div>
					{mode === "login" && (
						<div className="mt-8 pt-6 border-t border-kumo-line space-y-4">
							<p className="text-[11px] text-kumo-subtle text-center">
								忘记密码？请联系管理员获取重置链接。
							</p>
							{config.data?.accessBridgeAvailable && (
								<a
									href="/api/auth/access-login"
									className="flex items-center justify-center gap-2 text-xs text-kumo-strong"
								>
									通过 Cloudflare Access 登录
									<ArrowRightIcon size={13} />
								</a>
							)}
							<details className="text-center">
								<summary className="text-[10px] text-kumo-subtle cursor-pointer">
									首次部署？
								</summary>
								<Link
									to="/setup"
									className="inline-block mt-3 text-xs text-kumo-strong hover:underline"
								>
									初始化管理员账号
								</Link>
							</details>
						</div>
					)}
				</div>
			</div>
		</main>
	);
}
