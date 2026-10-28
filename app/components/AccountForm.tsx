import { Button, Input } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import api from "~/services/api";
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
	return (
		<main className="flex min-h-screen items-center justify-center bg-kumo-recessed px-4">
			<div className="w-full max-w-md space-y-5 rounded-xl border border-kumo-line bg-kumo-base p-7">
				<h1 className="text-2xl font-bold">
					{mode === "login"
						? "登录邮箱管理"
						: mode === "register"
							? "注册账号"
							: mode === "setup"
								? "初始化管理员"
								: "重置密码"}
				</h1>
				<p className="text-sm text-kumo-subtle">
					登录账号与收发邮箱独立，一个账号可以管理多个邮箱。
				</p>
				{mode === "register" && !params.get("token") && (
					<p className="text-sm text-kumo-subtle">
						{config.data?.registrationMode === "approval"
							? "注册后需管理员审核，不会自动获得邮箱权限。"
							: "当前仅接受管理员邀请，请索取邀请链接。"}
					</p>
				)}
				{error && (
					<p role="alert" className="text-kumo-error">
						{error}
					</p>
				)}
				{message && <p role="status">{message}</p>}
				{!message && (
					<form onSubmit={submit} className="space-y-4">
						{mode !== "reset" && (
							<Input
								label="登录邮箱"
								type="email"
								autoComplete="username"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
							/>
						)}
						{mode === "setup" && (
							<Input
								label="初始化凭据（BOOTSTRAP_TOKEN）"
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
							disabled={
								busy ||
								(mode === "register" &&
									!params.get("token") &&
									config.data?.registrationMode !== "approval")
							}
							className="w-full"
						>
							{busy
								? "处理中…"
								: mode === "login"
									? "登录"
									: mode === "register"
										? "注册"
										: "设置密码"}
						</Button>
					</form>
				)}
				<div className="flex flex-wrap gap-4 text-sm">
					<Link to="/login" className="underline">
						登录
					</Link>
					<Link to="/register" className="underline">
						注册
					</Link>
					{mode === "login" && (
						<Link to="/setup" className="underline">
							首次安装初始化
						</Link>
					)}
				</div>
				{mode === "login" && (
					<>
						<p className="text-xs text-kumo-subtle">
							忘记密码或需要邀请链接，请联系管理员。
						</p>
						{config.data?.accessBridgeAvailable && (
							<a
								href="/api/auth/access-login"
								className="block text-sm underline"
							>
								已有 Cloudflare Access 账号：进入并设置独立密码
							</a>
						)}
					</>
				)}
			</div>
		</main>
	);
}
