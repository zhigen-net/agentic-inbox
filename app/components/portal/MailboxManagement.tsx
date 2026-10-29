import { Button } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon, ArrowClockwiseIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import api, {
	type TeamMailbox,
	type TeamUser,
	type Domain,
} from "~/services/api";
import type { RunAction } from "~/routes/team";
import { EmptyState, StatusPill, SearchField, Notice } from "./PortalShell";
export default function MailboxManagement({
	mailboxes,
	users,
	domains,
	loading,
	busy,
	run,
}: {
	mailboxes: TeamMailbox[];
	users: TeamUser[];
	domains: Domain[];
	loading: boolean;
	busy: boolean;
	run: RunAction;
}) {
	const [params, setParams] = useSearchParams();
	const address = params.get("mailbox") || "";
	const [search, setSearch] = useState(""),
		[userId, setUserId] = useState(""),
		[role, setRole] = useState<"editor" | "viewer">("editor");
	const box = mailboxes.find((m) => m.address === address);
	const members = useQuery({
		queryKey: ["team-members", address],
		queryFn: () => api.listMailboxMembers(address),
		enabled: !!box?.active,
	});
	const list = mailboxes.filter((m) =>
		`${m.name} ${m.address}`.toLowerCase().includes(search.toLowerCase()),
	);
	return (
		<>
			<div className="portal-split">
				<section className="portal-panel">
					<div className="p-4 border-b border-kumo-line">
						<SearchField
							value={search}
							onChange={setSearch}
							placeholder="搜索邮箱…"
						/>
					</div>
					<div className="portal-item-list">
						{list.map((m) => (
							<button
								type="button"
								className="portal-list-item"
								key={m.address}
								aria-current={address === m.address ? "true" : undefined}
								onClick={() => {
									setParams({ tab: "mailboxes", mailbox: m.address });
									setUserId("");
								}}
							>
								<span className="flex items-center gap-2 justify-between">
									<span className="truncate text-xs font-semibold">
										{m.name}
									</span>
									{!m.active && <StatusPill>已停用</StatusPill>}
								</span>
								<span className="block text-[11px] text-kumo-subtle truncate mt-1.5">
									{m.address}
								</span>
							</button>
						))}
						{loading ? (
							<p className="p-4 text-xs text-kumo-subtle">正在加载…</p>
						) : (
							!list.length && (
								<p className="p-4 text-xs text-kumo-subtle">暂无匹配的邮箱</p>
							)
						)}
					</div>
				</section>
				<div className="space-y-5">
					{!box ? (
						<div className="portal-panel">
							<EmptyState
								title="选择一个邮箱"
								description="在左侧选择邮箱，查看成员权限和收发地址。"
							/>
						</div>
					) : (
						<>
							<div className="flex items-start justify-between gap-4">
								<div>
									<h2 className="text-lg font-semibold">{box.name}</h2>
									<p className="portal-section-help break-all">{box.address}</p>
								</div>
								{!!box.active && (
									<Link
										className="portal-text-link shrink-0"
										to={`/mailbox/${encodeURIComponent(address)}`}
									>
										打开邮箱
										<ArrowUpRightIcon size={14} />
									</Link>
								)}
							</div>
							{!box.active ? (
								<section className="portal-panel">
									<div className="portal-panel-body">
										<h3 className="portal-section-title">此邮箱已停用</h3>
										<p className="portal-section-help mt-2 mb-5">
											历史邮件已保留。恢复邮箱后，需要重新分配成员访问权限。
										</p>
										<Button
											variant="primary"
											disabled={busy}
											onClick={() =>
												void run(
													() => api.restoreMailbox(address),
													"邮箱已恢复，请重新分配成员",
												)
											}
										>
											恢复邮箱
										</Button>
									</div>
								</section>
							) : (
								<>
									<section className="portal-panel">
										<div className="portal-panel-heading">
											<div>
												<h2>成员与权限</h2>
												<p>共享同一邮箱，管理员始终拥有管理权限。</p>
											</div>
											<StatusPill>
												{members.data?.length || 0} 位成员
											</StatusPill>
										</div>
										{members.error && (
											<div className="px-5 pt-4">
												<Notice error>{members.error.message}</Notice>
											</div>
										)}
										<div className="divide-y divide-kumo-line">
											{members.data?.map((m) => (
												<div
													key={m.userId}
													className="px-5 py-4 flex items-center gap-3"
												>
													<span className="account-avatar">
														{m.email[0].toUpperCase()}
													</span>
													<div className="min-w-0 flex-1">
														<p className="truncate text-xs font-medium">
															{m.email}
														</p>
														<p className="portal-section-help">
															{m.role === "editor"
																? "可收发和编辑邮件"
																: "仅查看邮件"}
														</p>
													</div>
													<Button
														size="sm"
														variant="ghost"
														disabled={busy}
														onClick={() => {
															if (
																window.confirm(
																	`撤销 ${m.email} 对此邮箱的访问权限？`,
																)
															)
																void run(
																	() => api.revokeMailbox(address, m.userId),
																	"授权已撤销",
																);
														}}
													>
														移除
													</Button>
												</div>
											))}
										</div>
										{!members.isLoading && !members.data?.length && (
											<p className="p-5 text-xs text-kumo-subtle">
												尚未分配成员，当前仅管理员可访问。
											</p>
										)}
										<form
											className="p-5 bg-kumo-recessed border-t border-kumo-line flex flex-wrap gap-2"
											onSubmit={(e) => {
												e.preventDefault();
												void run(
													() => api.assignMailbox(address, userId, role),
													"成员授权已保存",
												).then((ok) => {
													if (ok) setUserId("");
												});
											}}
										>
											<select
												aria-label="选择成员"
												className="portal-select flex-1 min-w-36"
												value={userId}
												onChange={(e) => setUserId(e.target.value)}
												required
											>
												<option value="">选择团队成员</option>
												{users
													.filter((u) => u.active && u.status !== "pending")
													.map((u) => (
														<option value={u.id} key={u.id}>
															{u.email}
														</option>
													))}
											</select>
											<select
												aria-label="邮箱权限"
												className="portal-select"
												value={role}
												onChange={(e) =>
													setRole(e.target.value as "editor" | "viewer")
												}
											>
												<option value="editor">可收发和编辑</option>
												<option value="viewer">只读</option>
											</select>
											<Button
												type="submit"
												variant="secondary"
												disabled={busy || !userId}
											>
												添加 / 更新
											</Button>
										</form>
									</section>
									<Addresses
										key={address}
										address={address}
										domains={domains}
										busy={busy}
										run={run}
									/>
									<section className="portal-panel">
										<div className="portal-panel-body flex flex-wrap justify-between items-center gap-4">
											<div>
												<h3 className="portal-section-title">停用邮箱</h3>
												<p className="portal-section-help">
													停止收信并撤销成员访问，保留历史邮件。
												</p>
											</div>
											<Button
												variant="secondary"
												disabled={busy}
												onClick={() => {
													if (
														window.confirm(
															"确认停用此邮箱？将停止收信并撤销成员访问，历史邮件会保留。",
														)
													)
														void run(
															() => api.deleteMailbox(address),
															"邮箱已停用",
														);
												}}
											>
												停用邮箱
											</Button>
										</div>
									</section>
								</>
							)}
						</>
					)}
				</div>
			</div>
			<details className="mt-8 border-t border-kumo-line pt-5">
				<summary className="text-xs text-kumo-subtle cursor-pointer w-fit">
					历史邮箱维护
				</summary>
				<div className="mt-4 flex flex-wrap gap-4 items-center">
					<p className="portal-section-help max-w-lg">
						如果升级后有旧邮箱未出现在列表中，可以重新核对历史目录。该操作不会删除邮件。
					</p>
					<Button
						size="sm"
						variant="secondary"
						icon={<ArrowClockwiseIcon size={14} />}
						disabled={busy}
						onClick={() =>
							void run(async () => {
								let cursor: string | undefined;
								do {
									const page = await api.importMailboxes(cursor);
									cursor = page.cursor;
								} while (cursor);
							}, "旧邮箱目录已核对")
						}
					>
						核对旧邮箱目录
					</Button>
				</div>
			</details>
		</>
	);
}
function Addresses({
	address,
	domains,
	busy,
	run,
}: {
	address: string;
	domains: Domain[];
	busy: boolean;
	run: RunAction;
}) {
	const qc = useQueryClient();
	const q = useQuery({
		queryKey: ["mailbox-addresses", address],
		queryFn: () => api.getMailbox(address),
	});
	const [selected, setSelected] = useState<string[]>([]),
		[adding, setAdding] = useState(false);
	const available = domains.filter(
		(d) =>
			d.enabled &&
			!q.data?.addresses?.some((a) => a.address.endsWith("@" + d.name)),
	);
	async function update(data: unknown) {
		return run(async () => {
			await api.changeAddresses(address, data);
			await qc.invalidateQueries({ queryKey: ["mailbox-addresses", address] });
		}, "邮箱地址已更新");
	}
	return (
		<section className="portal-panel">
			<div className="portal-panel-heading">
				<div>
					<h2>收发地址</h2>
					<p>同一邮箱的多个地址共用邮件与授权。</p>
				</div>
				<Button
					variant="ghost"
					size="sm"
					onClick={() => setAdding(!adding)}
					disabled={busy || q.isLoading || !!q.error}
				>
					{adding ? "收起" : "添加地址"}
				</Button>
			</div>
			{q.error && (
				<div className="p-5">
					<Notice error>{q.error.message}</Notice>
				</div>
			)}
			{q.isLoading && (
				<p className="p-5 text-xs text-kumo-subtle">正在加载地址…</p>
			)}
			<div className="divide-y divide-kumo-line">
				{q.data?.addresses?.map((a) => {
					const primary = q.data.email === a.address;
					return (
						<div className="px-5 py-4" key={a.address}>
							<div className="flex flex-wrap justify-between gap-2 items-center">
								<span className="text-xs font-medium break-all">
									{a.address}
								</span>
								<div className="flex gap-2">
									{primary && <StatusPill>默认发件</StatusPill>}
									{!a.active && <StatusPill>已停用</StatusPill>}
									{!a.domain_send && (
										<StatusPill tone="amber">域名未启用发信</StatusPill>
									)}
								</div>
							</div>
							<div className="flex flex-wrap items-center justify-between gap-3 mt-4">
								<div className="flex gap-5">
									<label className="portal-checkbox">
										<input
											type="checkbox"
											checked={!!a.receive_enabled}
											disabled={busy || !a.active}
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
										/>
										收信
									</label>
									<label className="portal-checkbox">
										<input
											type="checkbox"
											checked={!!a.send_enabled}
											disabled={busy || !a.active || primary}
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
										/>
										发信
									</label>
								</div>
								<div className="flex gap-2">
									{!!a.active &&
										!!a.domain_send &&
										!!a.send_enabled &&
										!primary && (
											<Button
												variant="ghost"
												size="sm"
												disabled={busy}
												onClick={() =>
													void update({ defaultAddress: a.address })
												}
											>
												设为默认
											</Button>
										)}
									<Button
										variant="ghost"
										size="sm"
										disabled={busy || primary}
										onClick={() =>
											void update(
												a.active
													? { disable: [a.address] }
													: { enable: [a.address] },
											)
										}
									>
										{a.active ? "停用" : "启用"}
									</Button>
								</div>
							</div>
						</div>
					);
				})}
			</div>
			{adding && (
				<div className="p-5 border-t border-kumo-line bg-kumo-recessed">
					<fieldset>
						<legend className="text-xs font-medium mb-3">
							选择要添加的域名
						</legend>
						<div className="space-y-2">
							{available.map((d) => (
								<label className="portal-choice bg-kumo-base" key={d.name}>
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
									<span className="break-all">
										{address.split("@")[0]}@{d.name}
									</span>
								</label>
							))}
						</div>
						{!available.length && (
							<p className="portal-section-help">
								没有可追加的域名，请先在域名管理中添加。
							</p>
						)}
					</fieldset>
					<div className="mt-4 flex justify-end">
						<Button
							size="sm"
							variant="primary"
							disabled={busy || !selected.length}
							onClick={() =>
								void update({ addDomains: selected }).then((ok) => {
									if (ok) {
										setSelected([]);
										setAdding(false);
									}
								})
							}
						>
							添加所选地址
						</Button>
					</div>
				</div>
			)}
			<p className="px-5 py-4 border-t border-kumo-line text-[11px] text-kumo-subtle leading-6">
				停用地址保留占用权与历史邮件。更换默认地址后，才可停用原默认地址或关闭其发信。
			</p>
		</section>
	);
}
