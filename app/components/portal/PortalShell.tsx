import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";
import {
	EnvelopeSimpleIcon,
	SquaresFourIcon,
	ShieldCheckIcon,
	GearSixIcon,
	ArrowUpRightIcon,
} from "@phosphor-icons/react";
import { useMe } from "~/queries/team";
import AccountMenu from "~/components/AccountMenu";

export function Brand() {
	return (
		<Link to="/" className="portal-brand">
			<span className="brand-symbol">
				<EnvelopeSimpleIcon size={21} weight="bold" />
			</span>
			<span>
				Inbox<span className="brand-dot">.</span>
			</span>
		</Link>
	);
}
export default function PortalShell({
	children,
	admin = false,
	focused = false,
}: {
	children: ReactNode;
	admin?: boolean;
	focused?: boolean;
}) {
	const { data: me } = useMe();
	if (focused)
		return (
			<div className="mailbox-workspace">
				<header className="mailbox-workspace-header">
					<Brand />
					<nav aria-label="工作空间导航" className="mailbox-workspace-nav">
						<NavLink to="/" end>
							我的邮箱
						</NavLink>
						{me?.role === "admin" && <NavLink to="/team">管理后台</NavLink>}
					</nav>
					<div className="mailbox-workspace-account">
						<AccountMenu minimal />
					</div>
				</header>
				<main className="mailbox-workspace-content">{children}</main>
			</div>
		);

	return (
		<div className="portal-shell">
			<aside className="portal-sidebar">
				<Brand />
				<div className="portal-workspace-label">
					{admin ? "工作空间管理" : "个人工作空间"}
				</div>
				<nav className="portal-main-nav" aria-label="工作空间导航">
					<NavLink to="/" end>
						<SquaresFourIcon size={19} />
						我的邮箱
					</NavLink>
					<NavLink to="/account">
						<GearSixIcon size={19} />
						账号与安全
					</NavLink>
					{me?.role === "admin" && (
						<NavLink to="/team">
							<ShieldCheckIcon size={19} />
							管理后台
						</NavLink>
					)}
				</nav>
				<div className="portal-sidebar-note">
					<span className="portal-status-dot" />
					你的团队邮件工作空间
				</div>
				<div className="portal-sidebar-account">
					<AccountMenu />
				</div>
			</aside>
			<div className="portal-body">
				<header className="portal-topbar">
					<span className="text-kumo-subtle text-xs">
						工作空间 <span className="mx-2 text-kumo-inactive">/</span>
						<span className="text-kumo-default">
							{admin ? "管理后台" : "个人中心"}
						</span>
					</span>
					<Link to={admin ? "/" : "/account"} className="portal-text-link">
						{admin ? "返回邮箱" : "账号设置"}
						<ArrowUpRightIcon size={14} />
					</Link>
				</header>
				<main className="portal-content">{children}</main>
			</div>
		</div>
	);
}
export function PageHeading({
	eyebrow,
	title,
	description,
	action,
}: {
	eyebrow?: string;
	title: string;
	description: string;
	action?: ReactNode;
}) {
	return (
		<div className="portal-heading">
			<div>
				{eyebrow && <p className="portal-eyebrow">{eyebrow}</p>}
				<h1>{title}</h1>
				<p className="portal-description">{description}</p>
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</div>
	);
}
export function StatusPill({
	children,
	tone = "neutral",
}: {
	children: ReactNode;
	tone?: "neutral" | "green" | "amber";
}) {
	return <span className={`status-pill status-pill-${tone}`}>{children}</span>;
}
export function Notice({
	children,
	error = false,
}: {
	children: ReactNode;
	error?: boolean;
}) {
	return (
		<div
			role={error ? "alert" : "status"}
			className={`portal-notice ${error ? "portal-notice-error" : ""}`}
		>
			{children}
		</div>
	);
}
export function EmptyState({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div className="portal-empty">
			<span className="portal-empty-icon">
				<EnvelopeSimpleIcon size={26} />
			</span>
			<h3>{title}</h3>
			<p>{description}</p>
		</div>
	);
}
export function SearchField({
	value,
	onChange,
	placeholder,
}: {
	value: string;
	onChange: (value: string) => void;
	placeholder: string;
}) {
	return (
		<input
			className="portal-search"
			type="search"
			aria-label={placeholder}
			placeholder={placeholder}
			value={value}
			onChange={(e) => onChange(e.target.value)}
		/>
	);
}
