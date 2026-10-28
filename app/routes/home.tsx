import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import api from "~/services/api";
import { useMailboxes } from "~/queries/mailboxes";
import { useMe } from "~/queries/team";
export default function Home() {
	const { data: me } = useMe(),
		mailboxes = useMailboxes(),
		qc = useQueryClient();
	const config = useQuery({ queryKey: ["config"], queryFn: api.getConfig });
	const auth = useQuery({ queryKey: ["auth-config"], queryFn: api.authConfig });
	const users = useQuery({
		queryKey: ["team-users"],
		queryFn: api.listUsers,
		enabled: me?.role === "admin",
	});
	const [open, setOpen] = useState(false),
		[name, setName] = useState(""),
		[prefix, setPrefix] = useState(""),
		[domains, setDomains] = useState<string[]>([]),
		[primary, setPrimary] = useState(""),
		[owner, setOwner] = useState("");
	const [busy, setBusy] = useState(false),
		[error, setError] = useState("");
	function toggle(domain: string) {
		setDomains((old) =>
			old.includes(domain) ? old.filter((d) => d !== domain) : [...old, domain],
		);
	}
	async function create(e: FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError("");
		try {
			await api.createMultiMailbox({
				name: name || prefix,
				prefix,
				domains,
				defaultAddress:
					primary && domains.includes(primary)
						? `${prefix}@${primary}`
						: undefined,
				ownerId: owner || undefined,
			});
			await qc.invalidateQueries({ queryKey: ["mailboxes"] });
			setOpen(false);
			setName("");
			setPrefix("");
			setDomains([]);
			setPrimary("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "创建失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<main className="min-h-screen bg-kumo-recessed px-4 py-8">
			<div className="mx-auto max-w-3xl space-y-6">
				<header className="flex flex-wrap items-center justify-between gap-3">
					<h1 className="text-2xl font-bold">我的邮箱</h1>
					<nav className="flex gap-4 text-sm">
						{me?.role === "admin" && (
							<Link to="/team" className="underline">
								管理后台
							</Link>
						)}
						<Link to="/account" className="underline">
							账号设置
						</Link>
					</nav>
				</header>
				{auth.data?.user && !auth.data.user.hasPassword && (
					<p className="rounded border border-kumo-line bg-kumo-base p-3 text-sm">
						当前通过 Access 登录。
						<Link to="/account" className="underline">
							先设置独立登录密码
						</Link>
						，再调整外层访问策略。
					</p>
				)}
				<div className="flex items-center justify-between gap-3">
					<p className="text-sm text-kumo-subtle">
						{me?.email} · {me?.role === "admin" ? "管理员" : "成员"}
					</p>
					{config.data?.canCreate && (
						<Button
							variant="primary"
							onClick={() => {
								setOpen(true);
								setError("");
							}}
						>
							创建邮箱
						</Button>
					)}
				</div>
				{(mailboxes.error || config.error) && (
					<p role="alert" className="text-kumo-error">
						{(mailboxes.error || config.error)?.message}
					</p>
				)}
				{mailboxes.isLoading ? (
					<p>正在加载邮箱…</p>
				) : !mailboxes.data?.length ? (
					<div className="rounded-xl border border-kumo-line bg-kumo-base p-8">
						<h2 className="font-semibold">暂时没有邮箱</h2>
						<p className="mt-2 text-sm text-kumo-subtle">
							{config.data?.canCreate
								? "可以自行创建邮箱，或由管理员分配。"
								: "请联系管理员分配邮箱或开通创建权限。"}
						</p>
					</div>
				) : (
					<div className="space-y-3">
						{mailboxes.data.map((m) => (
							<div
								key={m.id}
								className="rounded-xl border border-kumo-line bg-kumo-base p-5"
							>
								<div className="flex items-center justify-between gap-3">
									<Link
										to={`/mailbox/${encodeURIComponent(m.id)}`}
										className="min-w-0"
									>
										<h2 className="font-semibold">
											{m.name}
											{m.unreadCount ? ` · ${m.unreadCount} 未读` : ""}
										</h2>
										<p className="text-sm">{m.email}</p>
									</Link>
									<span className="text-xs text-kumo-subtle">
										{m.role === "admin"
											? "管理员"
											: m.role === "viewer"
												? "只读"
												: "可编辑"}
										{m.ownerId && m.ownerId !== me?.id ? " · 共享邮箱" : ""}
									</span>
								</div>
								<p className="mt-2 break-all text-xs text-kumo-subtle">
									{m.addresses
										?.filter((a) => a.active)
										.map((a) => a.address)
										.join(" · ")}
								</p>
								{me?.role === "admin" && (
									<Button
										variant="ghost"
										size="sm"
										className="mt-3"
										onClick={async () => {
											if (
												!window.confirm(
													"停用后停止收信并撤销成员访问，历史邮件保留。继续？",
												)
											)
												return;
											try {
												await api.deleteMailbox(m.id);
												await qc.invalidateQueries({ queryKey: ["mailboxes"] });
											} catch (e) {
												setError(String(e));
											}
										}}
									>
										停用邮箱
									</Button>
								)}
							</div>
						))}
					</div>
				)}
				{error && !open && (
					<p role="alert" className="text-kumo-error">
						{error}
					</p>
				)}
				<Dialog.Root open={open} onOpenChange={setOpen}>
					<Dialog size="sm" className="p-6">
						<Dialog.Title>创建邮箱</Dialog.Title>
						<form onSubmit={create} className="mt-4 space-y-4">
							{error && (
								<p role="alert" className="text-kumo-error">
									{error}
								</p>
							)}
							<Input
								label="邮箱名称"
								placeholder="例如：销售邮箱"
								maxLength={80}
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
							<Input
								label="邮箱前缀"
								placeholder="sales"
								maxLength={64}
								pattern="[a-z0-9][a-z0-9._\-]*"
								value={prefix}
								onChange={(e) => setPrefix(e.target.value.toLowerCase())}
								required
							/>
							<fieldset className="space-y-2">
								<legend className="mb-2 text-sm font-medium">
									关联域名（可多选，同一个邮箱共用邮件）
								</legend>
								{config.data?.domains.map((d) => (
									<label key={d} className="flex gap-2 text-sm">
										<input
											type="checkbox"
											checked={domains.includes(d)}
											onChange={() => toggle(d)}
										/>
										{prefix || "前缀"}@{d}
									</label>
								))}
								{!config.data?.domains.length && (
									<p className="text-sm">没有可用域名，请联系管理员。</p>
								)}
							</fieldset>
							<label className="block text-sm">
								默认地址
								<select
									className="mt-1 w-full rounded border border-kumo-line bg-kumo-base p-2"
									value={domains.includes(primary) ? primary : domains[0] || ""}
									onChange={(e) => setPrimary(e.target.value)}
								>
									{domains.map((d) => (
										<option key={d} value={d}>
											{prefix || "前缀"}@{d}
										</option>
									))}
								</select>
							</label>
							{me?.role === "admin" && (
								<label className="block text-sm">
									分配给用户
									<select
										className="mt-1 w-full rounded border border-kumo-line bg-kumo-base p-2"
										value={owner}
										onChange={(e) => setOwner(e.target.value)}
									>
										<option value="">自己</option>
										{users.data
											?.filter(
												(u) =>
													u.active && u.status !== "pending" && u.id !== me.id,
											)
											.map((u) => (
												<option key={u.id} value={u.id}>
													{u.email}
												</option>
											))}
									</select>
								</label>
							)}
							<p className="text-xs text-kumo-subtle">
								最多关联 20
								个地址。地址冲突时全部取消创建；域名需完成配置后才能收发信。
							</p>
							<div className="flex justify-end gap-2">
								<Button type="button" onClick={() => setOpen(false)}>
									取消
								</Button>
								<Button
									type="submit"
									variant="primary"
									disabled={busy || !domains.length}
								>
									{busy ? "创建中…" : "创建"}
								</Button>
							</div>
						</form>
					</Dialog>
				</Dialog.Root>
			</div>
		</main>
	);
}
