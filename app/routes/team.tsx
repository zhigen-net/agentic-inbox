import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
	PlusIcon,
	UsersIcon,
	EnvelopeSimpleIcon,
	GlobeIcon,
	GearSixIcon,
	ClockCounterClockwiseIcon,
	CopyIcon,
	CheckIcon,
} from "@phosphor-icons/react";
import { useMe } from "~/queries/team";
import api from "~/services/api";
import PortalShell, {
	PageHeading,
	Notice,
	EmptyState,
	SearchField,
	StatusPill,
} from "~/components/portal/PortalShell";
import CreateMailboxDialog from "~/components/portal/CreateMailboxDialog";
import UserDetails from "~/components/portal/UserDetails";
import MailboxManagement from "~/components/portal/MailboxManagement";
import DomainManagement from "~/components/portal/DomainManagement";
import type { TeamUser } from "~/services/api";
export type RunAction = (
	action: () => Promise<unknown>,
	success?: string,
) => Promise<boolean>;
const tabs = [
	{
		id: "users",
		label: "用户管理",
		icon: UsersIcon,
		description: "管理团队成员、账号状态与邮箱创建权限。",
	},
	{
		id: "mailboxes",
		label: "邮箱管理",
		icon: EnvelopeSimpleIcon,
		description: "分配共享邮箱，管理收发地址和访问权限。",
	},
	{
		id: "domains",
		label: "域名管理",
		icon: GlobeIcon,
		description: "连接邮件域名，分别控制收信与发信能力。",
	},
	{
		id: "settings",
		label: "注册设置",
		icon: GearSixIcon,
		description: "选择适合团队的账号加入方式。",
	},
	{
		id: "operations",
		label: "操作记录",
		icon: ClockCounterClockwiseIcon,
		description: "查看工作空间最近的管理与安全操作。",
	},
];
export default function Team() {
	const { data: me } = useMe();
	const admin = me?.role === "admin";
	const qc = useQueryClient();
	const [params] = useSearchParams();
	const tab = tabs.find((t) => t.id === params.get("tab")) || tabs[0];
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
		enabled: admin && tab.id === "settings",
	});
	const operations = useQuery({
		queryKey: ["operations"],
		queryFn: api.operations,
		enabled: admin && tab.id === "operations",
	});
	const [busy, setBusy] = useState(false),
		[message, setMessage] = useState(""),
		[error, setError] = useState("");
	const [search, setSearch] = useState(""),
		[filter, setFilter] = useState("all"),
		[invite, setInvite] = useState(false),
		[email, setEmail] = useState(""),
		[create, setCreate] = useState(false);
	const [selected, setSelected] = useState<TeamUser | null>(null),
		[link, setLink] = useState<{
			url: string;
			title: string;
			description: string;
		} | null>(null),
		[copied, setCopied] = useState(false);
	const run: RunAction = async (action, success = "已保存") => {
		setBusy(true);
		setMessage("");
		setError("");
		try {
			await action();
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
					"permissions",
				].map((key) => qc.invalidateQueries({ queryKey: [key] })),
			);
			setMessage(success);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : "操作失败");
			return false;
		} finally {
			setBusy(false);
		}
	};
	const showLink = (url: string, title: string, description: string) => {
		setLink({ url, title, description });
		setCopied(false);
	};
	const list =
		users.data?.filter(
			(u) =>
				u.email.toLowerCase().includes(search.toLowerCase()) &&
				(filter === "all" ||
					(filter === "pending"
						? u.status === "pending"
						: filter === "active"
							? u.active && u.status !== "pending"
							: !u.active && u.status !== "pending")),
		) || [];
	const queryError =
		users.error ||
		domains.error ||
		mailboxes.error ||
		(tab.id === "settings"
			? settings.error
			: tab.id === "operations"
				? operations.error
				: null);
	if (!admin)
		return (
			<PortalShell>
				<EmptyState
					title="需要管理员权限"
					description="请返回我的邮箱，或联系工作空间管理员。"
				/>
			</PortalShell>
		);
	return (
		<PortalShell admin>
			<PageHeading
				eyebrow="WORKSPACE ADMIN"
				title={tab.label}
				description={tab.description}
				action={
					tab.id === "users" ? (
						<Button
							variant="primary"
							icon={<PlusIcon size={16} />}
							onClick={() => setInvite(true)}
						>
							邀请用户
						</Button>
					) : tab.id === "mailboxes" ? (
						<Button
							variant="primary"
							icon={<PlusIcon size={16} />}
							onClick={() => setCreate(true)}
						>
							创建邮箱
						</Button>
					) : undefined
				}
			/>
			<nav className="portal-tabs" aria-label="管理导航">
				{tabs.map((t) => (
					<Link
						key={t.id}
						to={`?tab=${t.id}`}
						onClick={() => {
							setMessage("");
							setError("");
							setSearch("");
						}}
						aria-current={tab.id === t.id ? "page" : undefined}
					>
						<t.icon size={16} />
						{t.label}
						{t.id === "users" &&
							!!users.data?.filter((u) => u.status === "pending").length && (
								<StatusPill tone="amber">
									{users.data.filter((u) => u.status === "pending").length}
								</StatusPill>
							)}
					</Link>
				))}
			</nav>
			{(error || queryError) && (
				<Notice error>{error || queryError?.message}</Notice>
			)}
			{message && <Notice>{message}</Notice>}
			{tab.id === "users" && (
				<>
					<div className="portal-toolbar">
						<div className="flex gap-3 items-center">
							<h2 className="portal-section-title">团队成员</h2>
							<span className="text-xs text-kumo-subtle">
								{users.data?.length || 0} 人
							</span>
						</div>
						<div className="flex flex-wrap gap-2">
							<SearchField
								value={search}
								onChange={setSearch}
								placeholder="搜索登录邮箱…"
							/>
							<select
								className="portal-select"
								aria-label="筛选用户状态"
								value={filter}
								onChange={(e) => setFilter(e.target.value)}
							>
								<option value="all">全部状态</option>
								<option value="active">已启用</option>
								<option value="pending">待审核</option>
								<option value="disabled">已停用</option>
							</select>
						</div>
					</div>
					<div className="portal-panel overflow-x-auto">
						<table className="portal-table portal-user-table">
							<thead>
								<tr>
									<th>用户</th>
									<th>角色</th>
									<th>状态</th>
									<th>邮箱权限</th>
									<th className="text-right">操作</th>
								</tr>
							</thead>
							<tbody>
								{list.map((u) => (
									<tr key={u.id}>
										<td>
											<div className="flex items-center gap-3">
												<span className="account-avatar">
													{u.email[0].toUpperCase()}
												</span>
												<span className="font-medium whitespace-nowrap">
													{u.email}
													{u.id === me.id && (
														<span className="ml-2 text-[10px] text-kumo-subtle">
															你
														</span>
													)}
												</span>
											</div>
										</td>
										<td>
											<span className="whitespace-nowrap">
												{u.role === "admin" ? "管理员" : "成员"}
											</span>
										</td>
										<td>
											<StatusPill
												tone={
													u.status === "pending"
														? "amber"
														: u.active
															? "green"
															: "neutral"
												}
											>
												{u.status === "pending"
													? "待审核"
													: u.active
														? "已启用"
														: "已停用"}
											</StatusPill>
										</td>
										<td className="text-kumo-subtle whitespace-nowrap">
											{u.role === "admin"
												? "管理所有邮箱"
												: u.can_create_mailboxes
													? `可自建 · ${u.mailbox_limit} 个`
													: "由管理员分配"}
										</td>
										<td className="text-right">
											<div className="flex justify-end gap-2">
												{u.status === "pending" && (
													<Button
														size="sm"
														disabled={busy}
														onClick={() =>
															void run(
																() => api.updateUser(u.id, u.role, true),
																"用户已批准",
															)
														}
													>
														批准
													</Button>
												)}
												<Button
													size="sm"
													variant="ghost"
													onClick={() => {
														setSelected(u);
														setError("");
													}}
												>
													管理
												</Button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{users.isLoading ? (
							<div className="p-8 text-xs text-kumo-subtle">正在加载成员…</div>
						) : (
							!list.length && (
								<EmptyState
									title="没有匹配的成员"
									description="调整筛选条件，或邀请新成员加入团队。"
								/>
							)
						)}
					</div>
					<p className="portal-section-help mt-4">
						注册账号与邮箱访问权限独立。用户加入后，可在邮箱管理中分配邮箱。
					</p>
				</>
			)}
			{tab.id === "mailboxes" && (
				<MailboxManagement
					mailboxes={mailboxes.data || []}
					users={users.data || []}
					domains={domains.data || []}
					loading={mailboxes.isLoading}
					busy={busy}
					run={run}
				/>
			)}
			{tab.id === "domains" && (
				<DomainManagement
					domains={domains.data || []}
					loading={domains.isLoading}
					busy={busy}
					run={run}
				/>
			)}
			{tab.id === "settings" && (
				<div className="portal-security-grid">
					<section className="portal-panel">
						<div className="portal-panel-heading">
							<div>
								<h2>新用户如何加入</h2>
								<p>用户注册后，仍需单独分配邮箱或创建权限。</p>
							</div>
						</div>
						<div className="portal-panel-body space-y-3">
							{[
								{
									id: "invite",
									title: "邀请加入",
									text: "管理员创建邀请链接，指定用户设置密码后加入。推荐用于内部团队。",
								},
								{
									id: "approval",
									title: "申请后审核",
									text: "开放注册申请，管理员批准后才可登录。",
								},
								{
									id: "closed",
									title: "关闭自主注册",
									text: "停止接受申请，已发出的有效邀请仍可使用。",
								},
							].map((o) => (
								<label className="portal-radio-option" key={o.id}>
									<input
										type="radio"
										name="registration"
										value={o.id}
										disabled={busy || settings.isLoading || !!settings.error}
										checked={settings.data?.registrationMode === o.id}
										onChange={() =>
											void run(
												() => api.setRegistrationMode(o.id),
												"注册方式已更新",
											)
										}
									/>
									<div>
										<span className="text-sm font-medium">
											{o.title}
											{o.id === "invite" && (
												<span className="ml-2">
													<StatusPill>推荐</StatusPill>
												</span>
											)}
										</span>
										<p className="portal-section-help">{o.text}</p>
									</div>
								</label>
							))}
						</div>
					</section>
					<aside className="portal-panel">
						<div className="portal-panel-body">
							<h2 className="portal-section-title">关于邀请与登录</h2>
							<div className="space-y-4 mt-4 text-xs text-kumo-subtle leading-7">
								<p>
									邀请和密码重置链接由管理员复制后交给用户，不会自动发送邮件。
								</p>
								<p>
									如果外层仍有全站 Cloudflare Access
									保护，用户需先通过该入口。请先验证管理员独立密码，再调整访问策略。
								</p>
								<Link
									to="/account"
									className="portal-text-link text-kumo-default"
								>
									前往账号与安全 →
								</Link>
							</div>
						</div>
					</aside>
				</div>
			)}
			{tab.id === "operations" && (
				<div className="portal-panel">
					<div className="portal-panel-heading">
						<div>
							<h2>最近操作</h2>
							<p>显示最近的管理记录，时间使用浏览器本地时区。</p>
						</div>
					</div>
					<div className="overflow-x-auto">
						<table className="portal-table">
							<thead>
								<tr>
									<th>操作</th>
									<th>操作人</th>
									<th>对象</th>
									<th>时间</th>
								</tr>
							</thead>
							<tbody>
								{operations.data?.map((o) => (
									<tr key={o.id}>
										<td className="whitespace-nowrap">
											{actionLabel(o.action)}
										</td>
										<td>{o.actor_email || "访客 / 系统"}</td>
										<td className="max-w-xs break-all text-kumo-subtle">
											{o.target}
										</td>
										<td className="whitespace-nowrap text-kumo-subtle">
											{formatDate(o.created_at)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					{operations.isLoading ? (
						<p className="p-8 text-xs text-kumo-subtle">正在加载记录…</p>
					) : (
						!operations.data?.length && (
							<EmptyState
								title="暂无操作记录"
								description="用户、邮箱和域名的管理操作将在这里显示。"
							/>
						)
					)}
				</div>
			)}
			<Dialog.Root open={invite} onOpenChange={(v) => !busy && setInvite(v)}>
				<Dialog size="sm" className="portal-dialog">
					<div className="portal-dialog-heading">
						<Dialog.Title className="text-lg font-semibold">
							邀请团队成员
						</Dialog.Title>
						<p className="portal-section-help">
							用对方的登录邮箱创建账号，稍后分配邮箱权限。
						</p>
					</div>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void run(async () => {
								const r = await api.inviteUser(email, "member");
								setEmail("");
								setInvite(false);
								if (r.inviteUrl)
									showLink(
										r.inviteUrl,
										"邀请链接已生成",
										"24 小时内有效，请私下发送给这位成员。",
									);
							}, "用户已创建");
						}}
					>
						<div className="portal-dialog-body">
							<Input
								label="登录邮箱"
								type="email"
								placeholder="name@example.com"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
							/>
							{error && (
								<div className="mt-4">
									<Notice error>{error}</Notice>
								</div>
							)}
						</div>
						<div className="portal-dialog-footer">
							<Button
								type="button"
								variant="secondary"
								onClick={() => setInvite(false)}
								disabled={busy}
							>
								取消
							</Button>
							<Button type="submit" variant="primary" disabled={busy}>
								{busy ? "生成中…" : "生成邀请链接"}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
			<Dialog.Root open={!!link} onOpenChange={(v) => !v && setLink(null)}>
				<Dialog size="sm" className="portal-dialog">
					<div className="portal-dialog-heading">
						<Dialog.Title className="text-lg font-semibold">
							{link?.title}
						</Dialog.Title>
						<p className="portal-section-help">{link?.description}</p>
					</div>
					<div className="portal-dialog-body">
						<input
							aria-label="一次性链接"
							className="portal-select w-full"
							value={link?.url || ""}
							readOnly
							onFocus={(e) => e.target.select()}
						/>
						<p className="portal-section-help mt-3">
							持有链接的人可以激活或重置账号，请仅通过可信渠道分享。
						</p>
					</div>
					<div className="portal-dialog-footer">
						<Button variant="secondary" onClick={() => setLink(null)}>
							关闭
						</Button>
						<Button
							variant="primary"
							icon={copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
							onClick={async () => {
								try {
									await navigator.clipboard.writeText(link?.url || "");
									setCopied(true);
								} catch {
									setError("无法自动复制，请选中链接手动复制");
								}
							}}
						>
							{copied ? "已复制" : "复制链接"}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
			{selected && (
				<UserDetails
					user={users.data?.find((u) => u.id === selected.id) || selected}
					domains={domains.data || []}
					meId={me.id}
					busy={busy}
					run={run}
					error={error}
					close={() => setSelected(null)}
					showLink={showLink}
				/>
			)}
			<CreateMailboxDialog open={create} onOpenChange={setCreate} />
		</PortalShell>
	);
}
function formatDate(value: string) {
	const d = new Date(value);
	return Number.isNaN(d.getTime())
		? value
		: d.toLocaleString("zh-CN", {
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
			});
}
function actionLabel(action: string) {
	const labels: Record<string, string> = {
		"account.login": "账号登录",
		"account.bootstrap": "初始化管理员",
		"account.register": "注册账号",
		"account.request-registration": "申请注册",
		"account.change-password": "修改密码",
		"account.reset-password": "重置密码",
		"registration.update": "更改注册方式",
		"mailbox.PUT": "更新邮箱授权",
		"mailbox.DELETE": "撤销邮箱授权",
		"mailbox.create": "创建邮箱",
		"mailbox.addresses": "更新邮箱地址",
		"auth.login": "账号登录",
		"auth.logout": "退出登录",
		"auth.register": "注册账号",
		"auth.password": "修改密码",
		"auth.reset": "重置密码",
		"auth.bootstrap": "初始化管理员",
		"user.invite": "邀请用户",
		"user.update": "更新用户",
		"user.permissions": "更新用户权限",
		"user.reset-link": "生成密码重置链接",
		"domain.create": "添加域名",
		"domain.update": "更新域名",
		"domain.check": "检测域名 MX",
		"settings.registration": "更改注册方式",
		"mailbox.disable": "停用邮箱",
		"mailbox.restore": "恢复邮箱",
		"mailbox.assign": "分配邮箱",
		"mailbox.revoke": "撤销邮箱授权",
	};
	return labels[action] || action;
}
