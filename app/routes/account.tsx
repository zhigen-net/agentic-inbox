import { Button, Input } from "@cloudflare/kumo";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
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
	const navigate = useNavigate();
	async function submit(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError("");
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
		<main className="mx-auto max-w-lg space-y-5 p-6">
			<Link to="/" className="underline">
				← 我的邮箱
			</Link>
			<h1 className="text-2xl font-bold">账号设置</h1>
			<p>{q.data?.user?.email}</p>
			{q.data?.user && !q.data.user.hasPassword && (
				<p>
					请先为已有账号设置独立密码。管理员确认密码登录正常后，才可移除覆盖全站的
					Access 保护。
				</p>
			)}
			{error && (
				<p role="alert" className="text-kumo-error">
					{error}
				</p>
			)}
			{message && <p role="status">{message}</p>}
			<form onSubmit={submit} className="space-y-4">
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
					label="新密码（至少 12 位）"
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
				<Button type="submit" disabled={busy}>
					保存密码
				</Button>
			</form>
			<Button
				variant="secondary"
				onClick={async () => {
					await api.logout();
					window.location.assign("/login");
				}}
			>
				退出登录
			</Button>
		</main>
	);
}
