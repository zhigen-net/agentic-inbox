import { Button } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import {
	ArrowRightIcon,
	EnvelopeSimpleIcon,
	PlusIcon,
	TrayIcon,
	GlobeIcon,
} from "@phosphor-icons/react";
import api from "~/services/api";
import { useMailboxes } from "~/queries/mailboxes";
import { useMe } from "~/queries/team";
import PortalShell, {
	PageHeading,
	StatusPill,
	Notice,
	EmptyState,
	SearchField,
} from "~/components/portal/PortalShell";
import CreateMailboxDialog from "~/components/portal/CreateMailboxDialog";

export default function Home() {
	const { data: me } = useMe();
	const mailboxes = useMailboxes();
	const config = useQuery({ queryKey: ["config"], queryFn: api.getConfig });
	const auth = useQuery({ queryKey: ["auth-config"], queryFn: api.authConfig });
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const boxes = mailboxes.data || [];
	const filtered = boxes.filter((m) =>
		`${m.name} ${m.email} ${m.addresses?.map((a) => a.address).join(" ") || ""}`
			.toLowerCase()
			.includes(search.toLowerCase()),
	);
	const unread = boxes.reduce((n, m) => n + (m.unreadCount || 0), 0);
	return (
		<PortalShell>
			<PageHeading
				eyebrow="YOUR WORKSPACE"
				title="我的邮箱"
				description="所有邮件，各归其位。选择一个邮箱，开始今天的工作。"
				action={
					config.data?.canCreate && (
						<Button
							variant="primary"
							icon={<PlusIcon size={16} />}
							onClick={() => setOpen(true)}
						>
							创建邮箱
						</Button>
					)
				}
			/>
			{auth.data?.user && !auth.data.user.hasPassword && (
				<Notice>
					<span className="flex flex-wrap items-center justify-between gap-2">
						<span>为账号设置独立密码，之后可使用邮箱和密码登录。</span>
						<Link
							to="/account"
							className="font-medium inline-flex items-center gap-1"
						>
							前往设置 <ArrowRightIcon size={14} />
						</Link>
					</span>
				</Notice>
			)}
			<div className="portal-stats">
				{[
					{ icon: EnvelopeSimpleIcon, value: boxes.length, label: "可用邮箱" },
					{ icon: TrayIcon, value: unread, label: "未读邮件" },
					{
						icon: GlobeIcon,
						value: boxes.reduce(
							(n, m) => n + (m.addresses?.filter((a) => a.active).length || 1),
							0,
						),
						label: "收发地址",
					},
				].map(({ icon: Icon, value, label }) => (
					<div className="portal-stat" key={label}>
						<span className="portal-stat-icon">
							<Icon size={21} />
						</span>
						<div>
							<strong>{mailboxes.isLoading ? "—" : value}</strong>
							<p>{label}</p>
						</div>
					</div>
				))}
			</div>
			<div className="portal-toolbar">
				<div className="flex items-center gap-3">
					<h2 className="portal-section-title">邮箱列表</h2>
					<span className="text-xs text-kumo-subtle">{boxes.length} 个</span>
				</div>
				<SearchField
					value={search}
					onChange={setSearch}
					placeholder="搜索名称或邮箱地址…"
				/>
			</div>
			{(mailboxes.error || config.error) && (
				<Notice error>{(mailboxes.error || config.error)?.message}</Notice>
			)}
			{mailboxes.isLoading ? (
				<div className="mailbox-grid" aria-label="正在加载邮箱">
					{[1, 2].map((i) => (
						<div
							key={i}
							className="portal-panel h-56 animate-pulse bg-kumo-recessed"
						/>
					))}
				</div>
			) : !filtered.length ? (
				<div className="portal-panel">
					<EmptyState
						title={search ? "没有找到匹配的邮箱" : "你的工作空间已准备好"}
						description={
							search
								? "试试其他名称或邮箱地址。"
								: config.data?.canCreate
									? "创建第一个邮箱，或联系管理员为你分配。"
									: "管理员分配邮箱后，就会在这里显示。"
						}
					/>
				</div>
			) : (
				<div className="mailbox-grid">
					{filtered.map((m) => {
						const aliases =
							m.addresses?.filter((a) => a.active && a.address !== m.email) ||
							[];
						return (
							<Link
								key={m.id}
								to={`/mailbox/${encodeURIComponent(m.id)}`}
								className="mailbox-card group"
							>
								<div className="flex items-center justify-between">
									<span className="mailbox-card-icon">
										<EnvelopeSimpleIcon size={23} />
									</span>
									{!!m.unreadCount ? (
										<StatusPill tone="amber">{m.unreadCount} 封未读</StatusPill>
									) : (
										<StatusPill>暂无未读</StatusPill>
									)}
								</div>
								<h2>{m.name}</h2>
								<p className="mailbox-card-address">{m.email}</p>
								<div className="mt-3 flex items-center gap-2">
									<StatusPill>
										{m.role === "viewer"
											? "只读"
											: m.role === "admin"
												? "管理员"
												: "可收发"}
									</StatusPill>
									{!!aliases.length && (
										<span
											className="text-[11px] text-kumo-subtle"
											title={aliases.map((a) => a.address).join("\n")}
										>
											另有 {aliases.length} 个收发地址
										</span>
									)}
								</div>
								<div className="mailbox-card-footer">
									<span>
										{m.ownerId && m.ownerId !== me?.id
											? "共享访问"
											: "团队邮箱"}
									</span>
									<span className="inline-flex items-center gap-2 text-kumo-strong">
										进入邮箱
										<ArrowRightIcon
											size={14}
											className="group-hover:translate-x-0.5 transition-transform"
										/>
									</span>
								</div>
							</Link>
						);
					})}
				</div>
			)}
			<CreateMailboxDialog open={open} onOpenChange={setOpen} />
		</PortalShell>
	);
}
