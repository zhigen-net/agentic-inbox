import { DropdownMenu } from "@cloudflare/kumo";
import {
	CaretUpDownIcon,
	GearSixIcon,
	SignOutIcon,
	SquaresFourIcon,
	ShieldCheckIcon,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useMe } from "~/queries/team";
import api from "~/services/api";

export default function AccountMenu({
	minimal = false,
}: {
	minimal?: boolean;
}) {
	const { data: me } = useMe();
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<div>
			<DropdownMenu>
				<DropdownMenu.Trigger className="account-trigger" aria-label="账号菜单">
					<span className="account-avatar">
						{(me?.email || "U").slice(0, 1).toUpperCase()}
					</span>
					<span className="min-w-0 flex-1 text-left">
						<span className="block truncate text-xs font-medium">
							{minimal ? "账号与设置" : me?.email}
						</span>
						{!minimal && (
							<span className="block text-[11px] text-kumo-subtle mt-0.5">
								{me?.role === "admin" ? "管理员" : "团队成员"}
							</span>
						)}
					</span>
					<CaretUpDownIcon size={14} className="shrink-0 text-kumo-subtle" />
				</DropdownMenu.Trigger>
				<DropdownMenu.Content
					style={{ zIndex: 60 }}
					side="top"
					align="end"
					className="w-64"
				>
					<DropdownMenu.Group>
						<DropdownMenu.Label>
							<span className="block truncate">{me?.email}</span>
						</DropdownMenu.Label>
						<DropdownMenu.Separator />
						<DropdownMenu.LinkItem href="/" icon={SquaresFourIcon}>
							我的邮箱
						</DropdownMenu.LinkItem>
						<DropdownMenu.LinkItem href="/account" icon={GearSixIcon}>
							账号与安全
						</DropdownMenu.LinkItem>
						{me?.role === "admin" && (
							<DropdownMenu.LinkItem href="/team" icon={ShieldCheckIcon}>
								管理后台
							</DropdownMenu.LinkItem>
						)}
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							icon={SignOutIcon}
							variant="danger"
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								try {
									await api.logout();
									window.location.assign("/login");
								} catch {
									setError("退出失败，请重试");
									setBusy(false);
								}
							}}
						>
							退出登录
						</DropdownMenu.Item>
					</DropdownMenu.Group>
				</DropdownMenu.Content>
			</DropdownMenu>
			{error && (
				<p role="alert" className="px-2 text-xs text-kumo-error">
					{error}
				</p>
			)}
		</div>
	);
}
