import { Button } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import {
	ArrowRightIcon,
	ArrowClockwiseIcon,
	EnvelopeSimpleIcon,
	PlusIcon,
	GearSixIcon,
} from "@phosphor-icons/react";
import api from "~/services/api";
import { useMailboxes } from "~/queries/mailboxes";
import PortalShell, {
	StatusPill,
	Notice,
	EmptyState,
	SearchField,
} from "~/components/portal/PortalShell";
import CreateMailboxDialog from "~/components/portal/CreateMailboxDialog";
import type { Mailbox } from "~/types";

export default function Home() {
	const mailboxes = useMailboxes();
	const config = useQuery({ queryKey: ["config"], queryFn: api.getConfig });
	const auth = useQuery({ queryKey: ["auth-config"], queryFn: api.authConfig });
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [unreadOnly, setUnreadOnly] = useState(false);
	const boxes = mailboxes.data || [];
	const filtered = boxes.filter(
		(m) =>
			(!unreadOnly || !!m.unreadCount) &&
			`${m.name} ${m.email} ${m.addresses?.map((a) => a.address).join(" ") || ""}`
				.toLowerCase()
				.includes(search.trim().toLowerCase()),
	);
	const unread = boxes.reduce((n, m) => n + (m.unreadCount || 0), 0);
	return (
		<PortalShell>
			<div className="mailbox-overview-heading">
				<div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
					<h1>我的邮箱</h1>
					<p className="text-xs text-kumo-subtle">
						{mailboxes.isLoading ? (
							"正在加载…"
						) : (
							<>
								{boxes.length} 个邮箱<span className="mx-2">·</span>
								{unread} 封未读
							</>
						)}
					</p>
				</div>
				{config.data?.canCreate && (
					<Button
						variant="primary"
						icon={<PlusIcon size={15} />}
						onClick={() => setOpen(true)}
					>
						创建邮箱
					</Button>
				)}
			</div>
			{auth.data?.user && !auth.data.user.hasPassword && (
				<p className="mailbox-password-hint">
					尚未设置独立登录密码。<Link to="/account">前往设置 →</Link>
				</p>
			)}
			<div className="mailbox-overview-toolbar">
				<div className="mailbox-view-filters" aria-label="邮箱筛选">
					<button
						type="button"
						aria-pressed={!unreadOnly}
						onClick={() => setUnreadOnly(false)}
					>
						全部邮箱 <span>{boxes.length}</span>
					</button>
					<button
						type="button"
						aria-pressed={unreadOnly}
						onClick={() => setUnreadOnly(true)}
					>
						有未读 <span>{boxes.filter((m) => m.unreadCount).length}</span>
					</button>
				</div>
				<div className="flex items-center gap-2">
					<SearchField
						value={search}
						onChange={setSearch}
						placeholder="搜索名称或邮箱地址…"
					/>
					<Button
						variant="ghost"
						size="sm"
						shape="square"
						aria-label="刷新邮箱"
						disabled={mailboxes.isFetching}
						onClick={() => void mailboxes.refetch()}
						icon={
							<ArrowClockwiseIcon
								size={16}
								className={mailboxes.isFetching ? "animate-spin" : ""}
							/>
						}
					/>
				</div>
			</div>
			{(mailboxes.error || config.error) && (
				<Notice error>{(mailboxes.error || config.error)?.message}</Notice>
			)}
			<section
				className="mailbox-overview-list"
				aria-label="邮箱列表"
				aria-busy={mailboxes.isLoading}
			>
				<div className="mailbox-overview-columns" aria-hidden="true">
					<span>邮箱 / 地址</span>
					<span>收发状态</span>
					<span>未读</span>
					<span>快捷操作</span>
				</div>
				{mailboxes.isLoading ? (
					<div className="p-6 space-y-4" aria-label="正在加载邮箱">
						{[1, 2, 3].map((i) => (
							<div
								key={i}
								className="h-12 rounded bg-kumo-recessed animate-pulse"
							/>
						))}
					</div>
				) : !filtered.length ? (
					<EmptyState
						title={
							search
								? "没有找到匹配的邮箱"
								: unreadOnly
									? "所有邮箱都已读完"
									: "暂时没有邮箱"
						}
						description={
							search
								? "试试邮箱名称、默认地址或关联地址。"
								: unreadOnly
									? "切换到全部邮箱，继续管理你的邮件。"
									: config.data?.canCreate
										? "创建一个邮箱，或联系管理员为你分配。"
										: "管理员分配邮箱后，会在这里显示。"
						}
					/>
				) : (
					filtered.map((m) => <MailboxRow key={m.id} mailbox={m} />)
				)}
			</section>
			<CreateMailboxDialog open={open} onOpenChange={setOpen} />
		</PortalShell>
	);
}
function MailboxRow({ mailbox: m }: { mailbox: Mailbox }) {
	const path = `/mailbox/${encodeURIComponent(m.id)}`;
	const addresses = m.addresses?.filter((a) => a.active) || [];
	const receive = addresses.some(
		(a) => a.domain_enabled && a.domain_receive && a.receive_enabled,
	);
	const send = addresses.some(
		(a) => a.domain_enabled && a.domain_send && a.send_enabled,
	);
	const known = !!m.addresses?.length;
	const status = !known
		? "查看配置"
		: receive && send
			? "收发已启用"
			: receive
				? "仅收信"
				: send
					? "仅发信"
					: "收发未开启";
	return (
		<article className="mailbox-overview-row">
			<div className="mailbox-overview-identity">
				<Link to={path} className="mailbox-overview-name">
					<span className="mailbox-overview-icon">
						<EnvelopeSimpleIcon size={20} />
					</span>
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h2 className="truncate">{m.name}</h2>
							{m.role === "viewer" && <StatusPill>只读</StatusPill>}
						</div>
						<span
							className="block truncate text-xs text-kumo-subtle mt-1"
							title={m.email}
						>
							{m.email}
						</span>
					</div>
				</Link>
				{addresses.length > 1 && (
					<details className="mailbox-address-details">
						<summary>{addresses.length} 个关联地址</summary>
						<ul>
							{addresses.map((a) => (
								<li key={a.address}>
									<span className="break-all">{a.address}</span>
									{a.address === m.email && (
										<span className="text-kumo-subtle text-[10px] shrink-0">
											默认
										</span>
									)}
								</li>
							))}
						</ul>
					</details>
				)}
			</div>
			<div className="mailbox-overview-status">
				<StatusPill
					tone={receive && send ? "green" : known ? "amber" : "neutral"}
				>
					{status}
				</StatusPill>
			</div>
			<Link
				to={`${path}/emails/inbox`}
				aria-label={`${m.name}：${m.unreadCount || 0} 封未读，打开收件箱`}
				className={`mailbox-overview-unread ${m.unreadCount ? "has-unread" : ""}`}
			>
				{m.unreadCount || 0}
				<span className="mailbox-mobile-unread-label"> 未读</span>
			</Link>
			<div className="mailbox-overview-actions">
				{m.role === "admin" && (
					<Link
						className="mailbox-manage-link"
						aria-label={`管理 ${m.name}`}
						title="管理地址与成员"
						to={`/team?tab=mailboxes&mailbox=${encodeURIComponent(m.id)}`}
					>
						<GearSixIcon size={16} />
						<span>管理</span>
					</Link>
				)}
				<Link to={path} className="mailbox-enter-link">
					进入邮箱
					<ArrowRightIcon size={14} />
				</Link>
			</div>
		</article>
	);
}
