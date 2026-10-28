import { Button, Input } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMe } from "~/queries/team";
import api, { type TeamUser, type Domain } from "~/services/api";
const selectClass = "rounded border border-kumo-line bg-kumo-base p-2 text-sm";
export default function Team() {
	const { data: me } = useMe(),
		qc = useQueryClient(),
		admin = me?.role === "admin";
	const users = useQuery({
		queryKey: ["team-users"],
		queryFn: api.listUsers,
		enabled: admin,
	});
	const domains = useQuery({
		queryKey: ["domains"],
		queryFn: api.listDomains,
		enabled: admin,
	});
	const mailboxes = useQuery({
		queryKey: ["team-mailboxes"],
		queryFn: api.listTeamMailboxes,
		enabled: admin,
	});
	const settings = useQuery({
		queryKey: ["registration-settings"],
		queryFn: api.getRegistrationSettings,
		enabled: admin,
	});
	const operations = useQuery({
		queryKey: ["operations"],
		queryFn: api.operations,
		enabled: admin,
	});
	const [tab, setTab] = useState("users"),
		[email, setEmail] = useState(""),
		[newDomain, setNewDomain] = useState(""),
		[address, setAddress] = useState(""),
		[userId, setUserId] = useState(""),
		[role, setRole] = useState<"editor" | "viewer">("editor");
	const [selectedUser, setSelectedUser] = useState<TeamUser | null>(null),
		[message, setMessage] = useState(""),
		[error, setError] = useState(""),
		[busy, setBusy] = useState(false);
	const members = useQuery({
		queryKey: ["team-members", address],
		queryFn: () => api.listMailboxMembers(address),
		enabled: admin && !!address,
	});
	async function run(action: () => Promise<unknown>, success = "已保存") {
		setBusy(true);
		setMessage("");
		setError("");
		try {
			const result = await action();
			setMessage(typeof result === "string" ? result : success);
			await Promise.all(
				[
					"team-users",
					"domains",
					"team-mailboxes",
					"team-members",
					"mailboxes",
					"config",
					"operations",
					"registration-settings",
				].map((key) => qc.invalidateQueries({ queryKey: [key] })),
			);
		} catch (e) {
			setError(e instanceof Error ? e.message : "操作失败");
		} finally {
			setBusy(false);
		}
	}
	if (!admin) return <p className="p-8">仅管理员可访问</p>;
	return (
		<main className="mx-auto max-w-5xl space-y-5 px-4 py-8">
			<Link to="/" className="underline">
				← 我的邮箱
			</Link>
			<h1 className="text-2xl font-bold">管理后台</h1>
			<nav className="flex flex-wrap gap-2">
				{[
					["users", "用户"],
					["mailboxes", "邮箱与授权"],
					["domains", "域名"],
					["settings", "注册设置"],
					["operations", "操作记录"],
				].map(([id, label]) => (
					<Button
						key={id}
						variant={tab === id ? "primary" : "secondary"}
						onClick={() => setTab(id)}
					>
						{label}
					</Button>
				))}
			</nav>
			{error && (
				<p role="alert" className="text-kumo-error">
					{error}
				</p>
			)}
			{message && (
				<p role="status" className="break-all rounded bg-kumo-fill p-3">
					{message}
				</p>
			)}
			{(users.error || domains.error || mailboxes.error || settings.error) && (
				<p role="alert">
					{
						(users.error || domains.error || mailboxes.error || settings.error)
							?.message
					}
				</p>
			)}
			{tab === "users" && (
				<section className="space-y-4">
					<form
						className="flex flex-wrap items-end gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							void run(async () => {
								const result = await api.inviteUser(email, "member");
								setEmail("");
								return result.inviteUrl
									? `邀请链接（24 小时有效，请私下交给用户）：${result.inviteUrl}`
									: "该用户已有密码，可以直接登录";
							}, "用户已创建");
						}}
					>
						<Input
							label="用户登录邮箱"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
						/>
						<Button type="submit" disabled={busy}>
							创建用户 / 生成邀请
						</Button>
					</form>
					<div className="overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead>
								<tr>
									<th>用户</th>
									<th>状态 / 角色</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody>
								{users.data?.map((u) => (
									<tr key={u.id} className="border-t border-kumo-line">
										<td className="py-4">
											{u.email}
											<p className="text-xs text-kumo-subtle">
												{u.can_create_mailboxes
													? `可自建，限 ${u.mailbox_limit} 个`
													: "仅使用分配的邮箱"}
											</p>
										</td>
										<td>
											{u.status === "pending"
												? "待审核"
												: u.active
													? "已启用"
													: "已停用"}{" "}
											· {u.role === "admin" ? "管理员" : "成员"}
										</td>
										<td>
											<div className="flex flex-wrap gap-2">
												<Button
													size="sm"
													disabled={busy || u.id === me.id}
													onClick={() =>
														void run(() =>
															api.updateUser(
																u.id,
																u.role,
																u.status === "pending" ? true : !u.active,
															),
														)
													}
												>
													{u.status === "pending"
														? "批准"
														: u.active
															? "停用"
															: "启用"}
												</Button>
												<Button
													size="sm"
													variant="secondary"
													onClick={() => setSelectedUser(u)}
												>
													创建权限
												</Button>
												<Button
													size="sm"
													variant="ghost"
													disabled={busy || u.id === me.id}
													onClick={() =>
														void run(() =>
															api.updateUser(
																u.id,
																u.role === "admin" ? "member" : "admin",
																!!u.active,
															),
														)
													}
												>
													{u.role === "admin" ? "设为成员" : "设为管理员"}
												</Button>
												<Button
													size="sm"
													disabled={busy || !u.active}
													onClick={() =>
														void run(async () => {
															const result = await api.resetLink(u.id);
															return `密码重置链接（1 小时有效，请私下交给用户）：${result.url}`;
														}, "已生成重置链接")
													}
												>
													重置密码链接
												</Button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{selectedUser && (
						<Permissions
							key={selectedUser.id}
							user={selectedUser}
							domains={domains.data || []}
							save={(data) =>
								run(() => api.setUserPermissions(selectedUser.id, data))
							}
							close={() => setSelectedUser(null)}
						/>
					)}
				</section>
			)}
			{tab === "mailboxes" && (
				<section className="space-y-4">
					<p className="text-sm text-kumo-subtle">
						在首页创建邮箱时可指定所属用户。在此添加其他成员，共享同一邮箱；只有管理员可以变更授权和地址。
					</p>
					<select
						aria-label="选择邮箱"
						className={selectClass + " w-full"}
						value={address}
						onChange={(e) => setAddress(e.target.value)}
					>
						<option value="">选择邮箱</option>
						{mailboxes.data?.map((m) => (
							<option key={m.address} value={m.address}>
								{m.name} · {m.address}
								{m.active ? "" : "（已停用）"}
							</option>
						))}
					</select>
					{address && (
						<>
							{!mailboxes.data?.find((m) => m.address === address)?.active ? (
								<Button
									onClick={() => void run(() => api.restoreMailbox(address))}
								>
									恢复邮箱（需重新分配成员）
								</Button>
							) : (
								<>
									<form
										className="flex flex-wrap gap-2"
										onSubmit={(e) => {
											e.preventDefault();
											void run(() => api.assignMailbox(address, userId, role));
										}}
									>
										<select
											aria-label="选择成员"
											required
											className={selectClass}
											value={userId}
											onChange={(e) => setUserId(e.target.value)}
										>
											<option value="">选择成员</option>
											{users.data
												?.filter((u) => u.active && u.status !== "pending")
												.map((u) => (
													<option key={u.id} value={u.id}>
														{u.email}
													</option>
												))}
										</select>
										<select
											aria-label="邮箱权限"
											className={selectClass}
											value={role}
											onChange={(e) => setRole(e.target.value as any)}
										>
											<option value="editor">可收发和编辑</option>
											<option value="viewer">只读</option>
										</select>
										<Button type="submit" disabled={busy || !userId}>
											分配邮箱
										</Button>
									</form>
									{members.data?.map((m) => (
										<div
											key={m.userId}
											className="flex justify-between border-b border-kumo-line py-2 text-sm"
										>
											<span>
												{m.email} · {m.role === "editor" ? "可编辑" : "只读"}
											</span>
											<Button
												size="sm"
												onClick={() =>
													void run(() => api.revokeMailbox(address, m.userId))
												}
											>
												撤销授权
											</Button>
										</div>
									))}
									<Addresses
										key={address}
										address={address}
										domains={domains.data || []}
										run={run}
									/>
								</>
							)}
						</>
					)}
					<Button
						variant="secondary"
						disabled={busy}
						onClick={() =>
							void run(async () => {
								let cursor: string | undefined;
								do {
									const p = await api.importMailboxes(cursor);
									cursor = p.cursor;
								} while (cursor);
							}, "旧邮箱目录已核对")
						}
					>
						重新核对旧邮箱目录
					</Button>
				</section>
			)}
			{tab === "domains" && (
				<section className="space-y-4">
					<form
						className="flex flex-wrap items-end gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							void run(async () => {
								await api.addDomain(newDomain);
								setNewDomain("");
							});
						}}
					>
						<Input
							label="新增域名"
							placeholder="site1.com"
							value={newDomain}
							onChange={(e) => setNewDomain(e.target.value)}
							required
						/>
						<Button type="submit" disabled={busy}>
							添加域名
						</Button>
					</form>
					<p className="text-sm text-kumo-subtle">
						添加域名不会改变现有邮箱。请在 Cloudflare 为域名配置 Email
						Routing、DNS 和发信验证后，启用相应能力。MX
						检测只验证收信路由，不代表发信验证通过。
					</p>
					{domains.data?.map((d) => (
						<DomainRow
							key={`${d.name}-${d.enabled}-${d.receive_enabled}-${d.send_enabled}-${d.checked_at}`}
							domain={d}
							run={run}
							busy={busy}
						/>
					))}
				</section>
			)}
			{tab === "settings" && (
				<section className="space-y-4">
					<label className="block">
						注册方式
						<select
							className={selectClass + " ml-3"}
							value={settings.data?.registrationMode || "invite"}
							onChange={(e) =>
								void run(() => api.setRegistrationMode(e.target.value))
							}
						>
							<option value="closed">关闭注册</option>
							<option value="invite">邀请注册</option>
							<option value="approval">注册后审核</option>
						</select>
					</label>
					<p className="text-sm text-kumo-subtle">
						注册不会自动授予邮箱或域名权限。密码找回由管理员生成一次性链接；邀请与重置链接不会自动发送邮件。若外层仍启用了全站
						Cloudflare
						Access，外部用户还需通过它；管理员设置并验证独立密码后再调整外层策略。
					</p>
				</section>
			)}
			{tab === "operations" && (
				<section className="space-y-2">
					{operations.data?.map((o) => (
						<div
							key={o.id}
							className="break-all border-b border-kumo-line py-2 text-sm"
						>
							<span>
								{o.created_at} · {o.actor_email || "未登录用户"} · {o.action}
							</span>
							<p className="text-kumo-subtle">{o.target}</p>
						</div>
					))}
				</section>
			)}
		</main>
	);
}
function Permissions({
	user,
	domains,
	save,
	close,
}: {
	user: TeamUser;
	domains: Domain[];
	save: (data: unknown) => Promise<unknown>;
	close: () => void;
}) {
	const permissions = useQuery({
		queryKey: ["permissions", user.id],
		queryFn: () => api.getUserPermissions(user.id),
	});
	const [canCreate, setCanCreate] = useState(!!user.can_create_mailboxes),
		[limit, setLimit] = useState(user.mailbox_limit ?? 3),
		[selected, setSelected] = useState<string[] | null>(null);
	const values = selected ?? permissions.data?.domains ?? [];
	const [sendLimit, setSendLimit] = useState(user.send_limit ?? 100),
		[aiLimit, setAiLimit] = useState(user.ai_limit ?? 50);
	return (
		<form
			className="space-y-3 rounded border border-kumo-line p-4"
			onSubmit={async (e) => {
				e.preventDefault();
				await save({
					canCreate,
					mailboxLimit: limit,
					sendLimit,
					aiLimit,
					domains: values,
				});
			}}
		>
			<h3 className="font-semibold">{user.email} 的创建权限</h3>
			<label className="flex gap-2">
				<input
					type="checkbox"
					checked={canCreate}
					onChange={(e) => setCanCreate(e.target.checked)}
				/>
				允许自行创建邮箱
			</label>
			<label className="block">
				自建邮箱上限
				<input
					aria-label="自建邮箱上限"
					type="number"
					min="0"
					max="1000"
					className={selectClass + " ml-2 w-24"}
					value={limit}
					onChange={(e) => setLimit(Number(e.target.value))}
				/>
			</label>
			<div className="flex flex-wrap gap-4">
				<label>
					每日发信尝试
					<input
						className={selectClass + " ml-2 w-24"}
						type="number"
						min="0"
						max="10000"
						value={sendLimit}
						onChange={(e) => setSendLimit(Number(e.target.value))}
					/>
				</label>
				<label>
					每日 AI 操作
					<input
						className={selectClass + " ml-2 w-24"}
						type="number"
						min="0"
						max="10000"
						value={aiLimit}
						onChange={(e) => setAiLimit(Number(e.target.value))}
					/>
				</label>
			</div>
			<p className="text-xs text-kumo-subtle">
				设置为 0 即关闭。每日额度按 UTC 日期统计。
			</p>
			<fieldset>
				<legend>允许使用的域名</legend>
				{domains
					.filter((d) => d.enabled)
					.map((d) => (
						<label key={d.name} className="mt-1 flex gap-2">
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
			</fieldset>
			<p className="text-xs text-kumo-subtle">
				管理员分配的邮箱不占用用户自建额度。每个邮箱最多 20 个地址。
			</p>
			<div className="flex gap-2">
				<Button type="submit">保存权限</Button>
				<Button type="button" onClick={close}>
					关闭
				</Button>
			</div>
		</form>
	);
}
function DomainRow({
	domain: d,
	run,
	busy,
}: {
	domain: Domain;
	run: any;
	busy: boolean;
}) {
	const [enabled, setEnabled] = useState(!!d.enabled),
		[receive, setReceive] = useState(!!d.receive_enabled),
		[send, setSend] = useState(!!d.send_enabled);
	return (
		<div className="space-y-3 rounded border border-kumo-line p-4">
			<h3 className="font-semibold">{d.name}</h3>
			<div className="flex flex-wrap gap-4 text-sm">
				{[
					[enabled, setEnabled, "域名启用"],
					[receive, setReceive, "允许收信"],
					[send, setSend, "允许发信（已在 CF 完成验证）"],
				].map(([v, set, label]: any) => (
					<label key={label} className="flex gap-2">
						<input
							type="checkbox"
							checked={v}
							onChange={(e) => set(e.target.checked)}
						/>
						{label}
					</label>
				))}
			</div>
			<p className="text-xs text-kumo-subtle">
				MX：
				{d.checked_at
					? d.mx_verified
						? "检测到 Cloudflare 收信记录"
						: "未检测到 Cloudflare 收信记录"
					: "尚未检测"}
				{d.checked_at ? ` · ${d.checked_at}` : ""}
			</p>
			<div className="flex gap-2">
				<Button
					disabled={busy}
					onClick={() =>
						void run(() =>
							api.updateDomain(d.name, {
								enabled,
								receiveEnabled: receive,
								sendEnabled: send,
							}),
						)
					}
				>
					保存
				</Button>
				<Button
					disabled={busy}
					variant="secondary"
					onClick={() =>
						void run(() => api.checkDomain(d.name), "MX 检测已更新")
					}
				>
					检测 MX
				</Button>
			</div>
		</div>
	);
}
function Addresses({
	address,
	domains,
	run,
}: {
	address: string;
	domains: Domain[];
	run: any;
}) {
	const qc = useQueryClient(),
		q = useQuery({
			queryKey: ["mailbox-addresses", address],
			queryFn: () => api.getMailbox(address),
		});
	const [selected, setSelected] = useState<string[]>([]);
	async function update(data: unknown) {
		await run(async () => {
			await api.changeAddresses(address, data);
			await qc.invalidateQueries({ queryKey: ["mailbox-addresses", address] });
		});
	}
	return (
		<div className="space-y-3 rounded border border-kumo-line p-4">
			<h3 className="font-semibold">收发地址</h3>
			{q.data?.addresses?.map((a) => (
				<div
					className="flex flex-wrap items-center justify-between gap-2 text-sm"
					key={a.address}
				>
					<span>
						{a.address}
						{q.data?.email === a.address ? " · 默认地址" : ""}
						{a.active ? "" : " · 已停用"}
						{!a.domain_send ? " · 域名未启用发信" : ""}
					</span>
					<div className="flex flex-wrap gap-2">
						<label>
							<input
								type="checkbox"
								checked={!!a.receive_enabled}
								onChange={(e) =>
									void update({
										options: [
											{
												address: a.address,
												receiveEnabled: e.target.checked,
												sendEnabled: !!a.send_enabled,
											},
										],
									})
								}
							/>{" "}
							收信
						</label>
						<label>
							<input
								type="checkbox"
								checked={!!a.send_enabled}
								onChange={(e) =>
									void update({
										options: [
											{
												address: a.address,
												receiveEnabled: !!a.receive_enabled,
												sendEnabled: e.target.checked,
											},
										],
									})
								}
							/>{" "}
							发信
						</label>
						{a.active && a.domain_send && q.data?.email !== a.address && (
							<Button
								size="sm"
								onClick={() => void update({ defaultAddress: a.address })}
							>
								设为默认
							</Button>
						)}
						<Button
							size="sm"
							onClick={() =>
								void update(
									a.active ? { disable: [a.address] } : { enable: [a.address] },
								)
							}
						>
							{a.active ? "停用" : "启用"}
						</Button>
					</div>
				</div>
			))}
			<fieldset>
				<legend className="text-sm">添加同前缀地址</legend>
				{domains
					.filter(
						(d) =>
							d.enabled &&
							!q.data?.addresses?.some((a) => a.address.endsWith("@" + d.name)),
					)
					.map((d) => (
						<label className="flex gap-2 text-sm" key={d.name}>
							<input
								type="checkbox"
								checked={selected.includes(d.name)}
								onChange={() =>
									setSelected((old) =>
										old.includes(d.name)
											? old.filter((x) => x !== d.name)
											: [...old, d.name],
									)
								}
							/>
							{address.split("@")[0]}@{d.name}
						</label>
					))}
			</fieldset>
			<Button
				disabled={!selected.length}
				onClick={() =>
					void update({ addDomains: selected }).then(() => setSelected([]))
				}
			>
				添加地址
			</Button>
			<p className="text-xs text-kumo-subtle">
				停用地址不会释放给其他用户，也不会删除历史邮件。停用默认地址前请先更换默认地址。
			</p>
		</div>
	);
}
