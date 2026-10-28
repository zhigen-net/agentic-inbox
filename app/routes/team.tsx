import { Button, Input, Loader } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { useMe } from "~/queries/team";
import api from "~/services/api";

const selectClass =
	"rounded-md border border-kumo-line bg-kumo-base p-2 text-sm text-kumo-default";
export default function TeamRoute() {
	const { data: me, error: identityError } = useMe();
	const qc = useQueryClient();
	const enabled = me?.role === "admin";
	const users = useQuery({
		queryKey: ["team-users"],
		queryFn: api.listUsers,
		enabled,
	});
	const mailboxes = useQuery({
		queryKey: ["team-mailboxes"],
		queryFn: api.listTeamMailboxes,
		enabled,
	});
	const config = useQuery({
		queryKey: ["config"],
		queryFn: api.getConfig,
		enabled,
	});
	const [email, setEmail] = useState("");
	const [userRole, setUserRole] = useState<"member" | "admin">("member");
	const [address, setAddress] = useState("");
	const [userId, setUserId] = useState("");
	const [mailboxRole, setMailboxRole] = useState<"viewer" | "editor">("editor");
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState("");
	const [error, setError] = useState("");
	const members = useQuery({
		queryKey: ["team-members", address],
		queryFn: () => api.listMailboxMembers(address),
		enabled: enabled && !!address,
	});
	async function run(action: () => Promise<unknown>, success: string) {
		setBusy(true);
		setError("");
		setMessage("");
		try {
			await action();
			setMessage(success);
			await Promise.all([
				qc.invalidateQueries({ queryKey: ["team-users"] }),
				qc.invalidateQueries({ queryKey: ["team-mailboxes"] }),
				qc.invalidateQueries({ queryKey: ["team-members"] }),
				qc.invalidateQueries({ queryKey: ["mailboxes"] }),
			]);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Operation failed");
		} finally {
			setBusy(false);
		}
	}
	function invite(event: FormEvent) {
		event.preventDefault();
		void run(async () => {
			await api.inviteUser(email, userRole);
			setEmail("");
		}, "Account invited. The user must also be allowed by your Cloudflare Access policy.");
	}
	if (identityError)
		return (
			<p role="alert" className="p-8">
				{identityError.message}
			</p>
		);
	if (!me)
		return (
			<div className="p-8">
				<Loader />
			</div>
		);
	if (!enabled)
		return (
			<div className="p-8">
				<Link to="/">Mailboxes</Link>
				<p>Administrator permission required.</p>
			</div>
		);
	return (
		<main className="min-h-screen bg-kumo-recessed text-kumo-default">
			<div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
				<Link to="/" className="text-sm underline">
					← Mailboxes
				</Link>
				<div>
					<h1 className="text-2xl font-bold">Team administration</h1>
					<p className="mt-2 text-sm text-kumo-subtle">
						Invite teammates and assign private or shared mailboxes.
						Administrators can access and manage all mailboxes.
					</p>
				</div>
				{error && (
					<p role="alert" className="text-kumo-error">
						{error}
					</p>
				)}
				{message && <p role="status">{message}</p>}
				{(users.error || mailboxes.error || members.error) && (
					<p role="alert" className="text-kumo-error">
						{(users.error || mailboxes.error || members.error)?.message}
					</p>
				)}
				<section className="space-y-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
					<h2 className="text-lg font-semibold">Team members</h2>
					<form onSubmit={invite} className="flex flex-wrap items-end gap-3">
						<Input
							label="Access login email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							required
						/>
						<label className="flex flex-col gap-1 text-sm">
							Team role
							<select
								className={selectClass}
								value={userRole}
								onChange={(e) =>
									setUserRole(e.target.value as "member" | "admin")
								}
							>
								<option value="member">Member</option>
								<option value="admin">Administrator</option>
							</select>
						</label>
						<Button type="submit" variant="primary" disabled={busy}>
							Invite member
						</Button>
					</form>
					<div className="overflow-x-auto">
						<table className="w-full text-left text-sm">
							<thead>
								<tr>
									<th className="py-2">Email</th>
									<th>Role</th>
									<th>Status</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{users.data?.map((user) => (
									<tr key={user.id} className="border-t border-kumo-line">
										<td className="py-3">
											{user.email}
											{user.id === me.id && " (you)"}
										</td>
										<td>{user.role}</td>
										<td>{user.active ? "Enabled" : "Disabled"}</td>
										<td>
											<div className="flex gap-2">
												<Button
													size="sm"
													variant="secondary"
													disabled={busy || user.id === me.id}
													onClick={() =>
														void run(
															() =>
																api.updateUser(
																	user.id,
																	user.role,
																	!user.active,
																),
															"Account updated.",
														)
													}
												>
													{user.active ? "Disable" : "Enable"}
												</Button>
												<Button
													size="sm"
													variant="ghost"
													disabled={busy || user.id === me.id}
													onClick={() =>
														void run(
															() =>
																api.updateUser(
																	user.id,
																	user.role === "admin" ? "member" : "admin",
																	!!user.active,
																),
															"Team role updated.",
														)
													}
												>
													{user.role === "admin" ? "Make member" : "Make admin"}
												</Button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</section>
				<section className="space-y-4 rounded-xl border border-kumo-line bg-kumo-base p-5">
					<h2 className="text-lg font-semibold">Mailbox access</h2>
					<p className="text-sm text-kumo-subtle">
						Assign several people to the same mailbox to share it. Viewers can
						read and search. Editors can also send, draft and organize mail.
					</p>
					<label className="flex flex-col gap-1 text-sm">
						Mailbox
						<select
							className={selectClass}
							value={address}
							onChange={(e) => setAddress(e.target.value)}
						>
							<option value="">Select a mailbox</option>
							{mailboxes.data?.map((m) => (
								<option key={m.address} value={m.address}>
									{m.address}
									{m.active ? "" : " (disabled)"}
								</option>
							))}
						</select>
					</label>
					{address &&
					!mailboxes.data?.find((m) => m.address === address)?.active ? (
						<Button
							disabled={busy}
							onClick={() =>
								void run(
									() => api.restoreMailbox(address),
									"Mailbox restored. Assign its members again.",
								)
							}
						>
							Restore mailbox
						</Button>
					) : (
						address && (
							<>
								<form
									className="flex flex-wrap items-end gap-3"
									onSubmit={(e) => {
										e.preventDefault();
										void run(
											() => api.assignMailbox(address, userId, mailboxRole),
											"Mailbox access saved.",
										);
									}}
								>
									<label className="flex flex-col gap-1 text-sm">
										Member
										<select
											className={selectClass}
											value={userId}
											onChange={(e) => setUserId(e.target.value)}
											required
										>
											<option value="">Select a member</option>
											{users.data
												?.filter((u) => u.active && u.role !== "admin")
												.map((u) => (
													<option key={u.id} value={u.id}>
														{u.email}
													</option>
												))}
										</select>
									</label>
									<label className="flex flex-col gap-1 text-sm">
										Mailbox role
										<select
											className={selectClass}
											value={mailboxRole}
											onChange={(e) =>
												setMailboxRole(e.target.value as "viewer" | "editor")
											}
										>
											<option value="editor">Editor</option>
											<option value="viewer">Viewer (read-only)</option>
										</select>
									</label>
									<Button type="submit" disabled={busy || !userId}>
										Save access
									</Button>
								</form>
								{members.data?.map((member) => (
									<div
										className="flex flex-wrap items-center justify-between gap-2 border-t border-kumo-line pt-3 text-sm"
										key={member.userId}
									>
										<span>
											{member.email} · {member.role}
											{member.active ? "" : " · account disabled"}
										</span>
										<Button
											size="sm"
											variant="secondary"
											disabled={busy}
											onClick={() =>
												void run(
													() => api.revokeMailbox(address, member.userId),
													"Mailbox access revoked.",
												)
											}
										>
											Revoke access
										</Button>
									</div>
								))}
								{!members.isLoading && !members.data?.length && (
									<p className="text-sm text-kumo-subtle">
										No members assigned. Only administrators can access this
										mailbox.
									</p>
								)}
							</>
						)
					)}
				</section>
				<section className="space-y-3 rounded-xl border border-kumo-line bg-kumo-base p-5">
					<h2 className="text-lg font-semibold">
						Domains and existing mailboxes
					</h2>
					<p className="text-sm">
						Available domains:{" "}
						{config.data?.domains.join(", ") || "None configured"}
					</p>
					<p className="text-sm text-kumo-subtle">
						Import mailboxes created before team permissions were enabled. Their
						mail and attachments stay in place; only administrators have access
						until members are assigned.
					</p>
					<Button
						disabled={busy}
						onClick={() =>
							void run(async () => {
								let cursor: string | undefined;
								do {
									const result = await api.importMailboxes(cursor);
									cursor = result.cursor;
								} while (cursor);
							}, "Existing mailboxes imported.")
						}
					>
						Import existing mailboxes
					</Button>
				</section>
			</div>
		</main>
	);
}
