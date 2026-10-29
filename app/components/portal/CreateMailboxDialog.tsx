import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { useMe } from "~/queries/team";
import api from "~/services/api";
import { Notice } from "./PortalShell";

export default function CreateMailboxDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { data: me } = useMe();
	const qc = useQueryClient();
	const config = useQuery({
		queryKey: ["config"],
		queryFn: api.getConfig,
		enabled: open,
	});
	const users = useQuery({
		queryKey: ["team-users"],
		queryFn: api.listUsers,
		enabled: open && me?.role === "admin",
	});
	const [name, setName] = useState(""),
		[prefix, setPrefix] = useState(""),
		[domains, setDomains] = useState<string[]>([]),
		[primary, setPrimary] = useState(""),
		[owner, setOwner] = useState("");
	const [busy, setBusy] = useState(false),
		[error, setError] = useState("");
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
			await Promise.all([
				qc.invalidateQueries({ queryKey: ["mailboxes"] }),
				qc.invalidateQueries({ queryKey: ["team-mailboxes"] }),
			]);
			onOpenChange(false);
			setName("");
			setPrefix("");
			setDomains([]);
			setPrimary("");
			setOwner("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "创建失败");
		} finally {
			setBusy(false);
		}
	}
	return (
		<Dialog.Root
			open={open}
			onOpenChange={(v) => {
				if (!busy) {
					onOpenChange(v);
					setError("");
				}
			}}
		>
			<Dialog size="sm" className="portal-dialog">
				<div className="portal-dialog-heading">
					<Dialog.Title className="text-lg font-semibold">
						创建邮箱
					</Dialog.Title>
					<p className="portal-section-help">
						一个邮箱，多个域名地址，共用同一份邮件。
					</p>
				</div>
				<form onSubmit={create}>
					<div className="portal-dialog-body space-y-5">
						{error && <Notice error>{error}</Notice>}
						{config.error && <Notice error>{config.error.message}</Notice>}
						<Input
							label="邮箱名称"
							placeholder="例如：销售团队"
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
						<fieldset>
							<legend className="text-xs font-medium mb-2.5">
								关联域名{" "}
								<span className="text-kumo-subtle font-normal">· 可多选</span>
							</legend>
							<div className="grid gap-2 max-h-48 overflow-y-auto">
								{config.data?.domains.map((d) => (
									<label className="portal-choice" key={d}>
										<input
											type="checkbox"
											checked={domains.includes(d)}
											onChange={() =>
												setDomains((old) =>
													old.includes(d)
														? old.filter((x) => x !== d)
														: [...old, d],
												)
											}
										/>
										<span className="text-kumo-subtle">
											{prefix || "前缀"}
											<span className="text-kumo-default">@{d}</span>
										</span>
									</label>
								))}
							</div>
							{!config.isLoading && !config.data?.domains.length && (
								<p className="portal-section-help">
									暂无可用域名，请联系管理员配置。
								</p>
							)}
						</fieldset>
						{domains.length > 1 && (
							<label className="portal-label">
								默认发件地址
								<select
									className="portal-select"
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
						)}
						{me?.role === "admin" && (
							<label className="portal-label">
								所属用户
								<select
									className="portal-select"
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
					</div>
					<div className="portal-dialog-footer">
						<Button
							type="button"
							variant="secondary"
							disabled={busy}
							onClick={() => onOpenChange(false)}
						>
							取消
						</Button>
						<Button
							type="submit"
							variant="primary"
							disabled={busy || !domains.length || domains.length > 20}
						>
							{busy ? "创建中…" : "创建邮箱"}
						</Button>
					</div>
				</form>
			</Dialog>
		</Dialog.Root>
	);
}
