import { Button, Dialog, Input } from "@cloudflare/kumo";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import api, { type Domain } from "~/services/api";
import type { DomainPlan } from "../../../shared/domain-health";
import { Notice } from "./PortalShell";
import DomainHealthView from "./DomainHealthView";
export default function DomainWizard({
	domain: d,
	close,
}: {
	domain: Domain;
	close: () => void;
}) {
	const qc = useQueryClient();
	const connections = useQuery({
		queryKey: ["domain-connections"],
		queryFn: api.domainConnections,
	});
	const health = useQuery({
		queryKey: ["domain-health", d.name],
		queryFn: () => api.domainHealth(d.name),
		staleTime: 60000,
		retry: false,
	});
	const [tab, setTab] = useState("status"),
		[mode, setMode] = useState(d.setup_mode || "cloudflare"),
		[connection, setConnection] = useState(d.connection_id || ""),
		[sender, setSender] = useState(d.send_connection_id || ""),
		[zone, setZone] = useState(d.zone_id || ""),
		[selector, setSelector] = useState(d.dkim_selector || "");
	const [busy, setBusy] = useState(false),
		[error, setError] = useState(""),
		[message, setMessage] = useState(""),
		[enableSending, setEnableSending] = useState(false),
		[plan, setPlan] = useState<DomainPlan | null>(null);
	const [relay, setRelay] = useState<Awaited<
			ReturnType<typeof api.domainRelay>
		> | null>(null),
		[probe, setProbe] = useState<{ address: string; expiresAt: number } | null>(
			null,
		),
		[probeResult, setProbeResult] = useState(""),
		[from, setFrom] = useState(""),
		[to, setTo] = useState("");
	async function action(fn: () => Promise<unknown>, success = "已完成") {
		setBusy(true);
		setError("");
		setMessage("");
		try {
			await fn();
			await qc.invalidateQueries({ queryKey: ["domains"] });
			setMessage(success);
		} catch (e) {
			setError(e instanceof Error ? e.message : "操作失败");
		} finally {
			setBusy(false);
		}
	}
	const dirty =
		mode !== (d.setup_mode || "cloudflare") ||
		(mode === "cloudflare" &&
			(connection !== (d.connection_id || "") || zone !== (d.zone_id || ""))) ||
		sender !== (d.send_connection_id || "") ||
		selector !== (d.dkim_selector || "");
	const account = connections.data?.connections.find(
			(x) => x.id === connection,
		),
		cross =
			!!account?.account_id &&
			!!connections.data?.accountId &&
			account.account_id !== connections.data.accountId;
	function invalidatePlan() {
		setPlan(null);
		setRelay(null);
	}
	return (
		<Dialog.Root open onOpenChange={(v) => !v && !busy && close()}>
			<Dialog size="lg" className="portal-dialog domain-wizard">
				<div className="portal-dialog-heading">
					<Dialog.Title className="text-lg font-semibold">
						{d.name}
					</Dialog.Title>
					<p className="portal-section-help">检查异常、配置接入、验证收发。</p>
				</div>
				<div className="px-7 pt-5">
					<nav className="portal-tabs !mb-0" aria-label="域名配置步骤">
						{[
							["status", "状态检查"],
							["setup", "接入设置"],
							["configure", "配置向导"],
							["test", "收发测试"],
						].map(([id, label]) => (
							<button
								type="button"
								className={`domain-wizard-tab ${tab === id ? "is-active" : ""}`}
								key={id}
								onClick={() => setTab(id)}
							>
								{label}
							</button>
						))}
					</nav>
				</div>
				<div className="portal-dialog-body space-y-5">
					{(error || health.error) && (
						<Notice error>{error || health.error?.message}</Notice>
					)}
					{message && <Notice>{message}</Notice>}
					{tab === "status" && (
						<>
							<div className="flex justify-between gap-3 items-center">
								<span className="text-xs text-kumo-subtle">
									系统设置：{d.enabled ? "已启用" : "已停用"} · 收信
									{d.receive_enabled ? "允许" : "关闭"} · 发信
									{d.send_enabled ? "允许" : "关闭"}
								</span>
								<Button
									size="sm"
									variant="secondary"
									disabled={busy || health.isFetching || dirty}
									onClick={() => void health.refetch()}
								>
									{health.isFetching ? "检测中…" : "重新检测"}
								</Button>
							</div>
							{health.data ? (
								<DomainHealthView health={health.data} />
							) : health.isLoading ? (
								<p className="text-xs text-kumo-subtle">
									正在检查 DNS 与服务状态…
								</p>
							) : null}
							<Button variant="primary" onClick={() => setTab("setup")}>
								配置接入方式
							</Button>
						</>
					)}
					{tab === "setup" && (
						<form
							className="space-y-4"
							onSubmit={(e) => {
								e.preventDefault();
								void action(async () => {
									await api.saveDomainSetup(d.name, {
										mode,
										connectionId:
											mode === "cloudflare" ? connection || null : null,
										sendConnectionId: sender || null,
										zoneId: mode === "cloudflare" ? zone || null : null,
										dkimSelector: selector,
									});
									invalidatePlan();
									await health.refetch();
								}, "接入设置已保存，请查看检测结果或生成配置预览");
							}}
						>
							<label className="portal-label">
								接入模式
								<select
									className="portal-select"
									value={mode}
									onChange={(e) => {
										setMode(e.target.value as "cloudflare" | "external");
										invalidatePlan();
									}}
								>
									<option value="cloudflare">
										Cloudflare DNS / Email Routing
									</option>
									<option value="external">外部 DNS / 其他收信服务</option>
								</select>
							</label>
							{mode === "cloudflare" && (
								<>
									<label className="portal-label">
										域名所属 Cloudflare 账户连接
										<select
											className="portal-select"
											value={connection}
											onChange={(e) => {
												setConnection(e.target.value);
												setZone("");
												invalidatePlan();
											}}
										>
											<option value="">选择已授权账户</option>
											{connections.data?.connections
												.filter((x) => x.provider === "cloudflare")
												.map((x) => (
													<option key={x.id} value={x.id}>
														{x.name}
														{x.account_id === connections.data?.accountId
															? "（主系统账户）"
															: "（其他账户）"}
													</option>
												))}
										</select>
									</label>
									{cross && (
										<Notice>
											此域名在其他账户。保存后到“配置向导”部署接入
											Worker，再配置路由；发信将使用所选账户的 Email Sending。
										</Notice>
									)}
								</>
							)}
							{mode === "external" && (
								<Notice>
									域名注册商不影响接入。若 DNS 不迁入 Cloudflare，需使用支持原始
									MIME 的收信服务或适配器调用本站签名接入接口；不能仅添加
									Cloudflare MX 就视为完成。下方可独立选择 Resend 发信。
								</Notice>
							)}
							<label className="portal-label">
								发信连接
								<select
									className="portal-select"
									value={sender}
									onChange={(e) => {
										setSender(e.target.value);
										invalidatePlan();
									}}
								>
									<option value="">
										{mode === "cloudflare"
											? "同账户沿用主 Worker；跨账户使用所选账户 API"
											: "请选择独立发信连接"}
									</option>
									{connections.data?.connections.map((x) => (
										<option key={x.id} value={x.id}>
											{x.name} · {x.provider}
										</option>
									))}
								</select>
							</label>
							<details className="compact-health-group">
								<summary>
									高级 DNS 选项{zone || selector ? " · 已设置" : ""}
								</summary>
								<div className="space-y-4 mt-4">
									{mode === "cloudflare" && (
										<>
											<Input
												label="Zone ID（选填，根域名自动查找；子域名可指定父 Zone）"
												value={zone}
												pattern="[a-f0-9]{32}"
												onChange={(e) => {
													setZone(e.target.value.trim());
													invalidatePlan();
												}}
											/>
										</>
									)}
									<Input
										label="DKIM 选择器（选填，可用英文逗号分隔）"
										placeholder="从发信服务复制，例如 selector1"
										value={selector}
										pattern="([a-zA-Z0-9_-]+(,[a-zA-Z0-9_-]+)*)?"
										onChange={(e) => {
											setSelector(e.target.value);
											invalidatePlan();
										}}
									/>
								</div>
							</details>
							<p className="portal-section-help">
								账户连接请在域名管理页的“服务连接”中添加。令牌更新后需要重新检测。先保存接入设置，再进行自动配置。
							</p>
							<Button
								type="submit"
								variant="primary"
								disabled={busy || connections.isLoading}
							>
								{busy ? "保存中…" : "保存接入设置"}
							</Button>
						</form>
					)}
					{tab === "configure" && (
						<>
							{dirty && (
								<Notice>
									接入设置尚未保存，请先回到接入设置保存，再生成变更预览。
								</Notice>
							)}
							<p className="portal-section-help">
								本页使用已保存的接入设置。现有第三方 MX、冲突 SPF 和其他
								Catch-all 不会被自动覆盖。
							</p>
							{health.data?.crossAccount && (
								<section className="border border-kumo-line rounded-lg p-4 space-y-3">
									<h3 className="portal-section-title">跨账户收信接入</h3>
									<p className="portal-section-help">
										将部署本站专用接入
										Worker，使用签名接口转发邮件。不复制主站数据库，不向接入
										Worker 下发 API 令牌。
									</p>
									<Button
										variant="secondary"
										disabled={busy || dirty}
										onClick={() =>
											void action(async () => {
												await api.domainRelay(d.name, "deploy");
												setPlan(null);
												await health.refetch();
											}, "接入 Worker 已部署，请重新生成路由配置预览")
										}
									>
										部署跨账户接入 Worker
									</Button>
								</section>
							)}
							{mode === "cloudflare" && (
								<>
									<label className="portal-checkbox">
										<input
											type="checkbox"
											checked={enableSending}
											disabled={busy}
											onChange={(e) => {
												setEnableSending(e.target.checked);
												setPlan(null);
											}}
										/>
										预览包含开通 Cloudflare 发信域名（可能产生服务用量费用）
									</label>
									<Button
										variant="secondary"
										disabled={busy || health.isFetching || dirty}
										onClick={() =>
											void action(async () => {
												const p = await api.domainPlan(d.name, enableSending);
												setPlan(p);
												qc.setQueryData(["domain-health", d.name], p.health);
											}, "变更预览已生成，尚未修改服务配置")
										}
									>
										生成自动配置预览
									</Button>
								</>
							)}
							{plan && (
								<section className="rounded-lg border border-kumo-line p-4 space-y-3">
									<h3 className="portal-section-title">变更预览</h3>
									{plan.blockers.length > 0 && (
										<Notice error>
											{plan.blockers.map((x) => (
												<p key={x}>· {x}</p>
											))}
										</Notice>
									)}
									{plan.warnings.map((x) => (
										<p key={x} className="text-xs text-kumo-subtle">
											注意：{x}
										</p>
									))}
									<ul className="list-disc pl-4 space-y-2 text-xs">
										{plan.changes.map((x) => (
											<li key={x}>{x}</li>
										))}
									</ul>
									{!plan.changes.length && (
										<p className="text-xs">没有需要自动修改的项目。</p>
									)}
									<p className="portal-section-help">
										预览 10
										分钟内有效。执行前会再次读取配置；发生变化时需重新生成。
									</p>
									<Button
										variant="primary"
										disabled={
											busy ||
											dirty ||
											!!plan.blockers.length ||
											!plan.changes.length
										}
										onClick={() =>
											void action(async () => {
												await api.applyDomainPlan(d.name, plan.id);
												setPlan(null);
												await health.refetch();
											}, "配置已执行，请检查结果并测试实际收发")
										}
									>
										确认执行以上变更
									</Button>
								</section>
							)}
							<details className="rounded-lg border border-kumo-line p-4">
								<summary className="text-xs font-medium cursor-pointer">
									手动配置步骤与 DNS 记录
								</summary>
								<ol className="text-xs text-kumo-subtle leading-7 list-decimal pl-4 mt-3">
									<li>
										在 Cloudflare 选择域名，开通 Email
										Routing，按该服务提供的实际值配置 DNS。
									</li>
									<li>
										将 Catch-all 指向{" "}
										{health.data?.workerName ||
											connections.data?.workerName ||
											"主站或接入 Worker"}
										，核对已有地址规则。
									</li>
									<li>
										在发信服务登记域名并完成验证；外部 DNS 可使用 Resend
										提供的记录。
									</li>
									<li>
										保留现有网站记录，已有企业邮请先规划迁移，SPF 应合并成一条。
									</li>
									<li>
										重新检测后，在“收发测试”验证链路，再确认系统收发开关。
									</li>
								</ol>
								<a
									href="https://dash.cloudflare.com/"
									target="_blank"
									rel="noreferrer"
									className="portal-text-link mt-3"
								>
									打开 Cloudflare 控制台 ↗
								</a>
								{health.data?.requiredRecords.length ? (
									<div className="mt-4 space-y-3">
										{health.data.requiredRecords.map((x, i) => (
											<div
												key={i}
												className="text-xs rounded bg-kumo-recessed p-3"
											>
												<p className="font-medium">
													{x.type} · {x.name}
													{x.priority !== undefined
														? ` · 优先级 ${x.priority}`
														: ""}
												</p>
												<input
													className="portal-select w-full mt-2"
													aria-label={`DNS 记录 ${i + 1}`}
													value={x.content}
													readOnly
													onFocus={(e) => e.target.select()}
												/>
											</div>
										))}
									</div>
								) : (
									<p className="portal-section-help mt-3">
										尚未取得服务要求的记录。请先授权账户连接，或从服务商复制实际记录；系统不会猜测
										DKIM/SPF 值。
									</p>
								)}
							</details>
							<details className="rounded-lg border border-kumo-line p-4">
								<summary className="text-xs font-medium cursor-pointer">
									外部收信服务 / 手动部署接入 Worker
								</summary>
								<p className="portal-section-help mt-3">
									此接口只接受 HMAC 签名的原始
									MIME。服务商需要支持该协议或部署适配器；普通 SMTP/IMAP
									不能直接连接。全站 Access 如仍开启，请仅为 /ingress/email/*
									配置服务接入，不开放管理 API。
								</p>
								<Button
									size="sm"
									variant="secondary"
									className="mt-3"
									disabled={busy}
									onClick={() =>
										void action(
											async () =>
												setRelay(await api.domainRelay(d.name, "credentials")),
											"接入参数已生成，请仅通过可信渠道交给服务端适配器",
										)
									}
								>
									生成接入参数
								</Button>
								{relay?.secret && (
									<div className="space-y-3 mt-4">
										<Input
											label="接入 URL"
											value={relay.endpoint || ""}
											readOnly
										/>
										<Input
											label="签名密钥（仅服务端使用）"
											type="password"
											value={relay.secret}
											readOnly
											onFocus={(e) => e.target.select()}
										/>
										<p className="portal-section-help break-words">
											{relay.protocol}
										</p>
										<Button
											size="sm"
											variant="secondary"
											onClick={() => {
												const url = URL.createObjectURL(
													new Blob([JSON.stringify(relay, null, 2)], {
														type: "application/json",
													}),
												);
												const a = document.createElement("a");
												a.href = url;
												a.download = d.name + "-private-relay.json";
												a.click();
												setTimeout(() => URL.revokeObjectURL(url), 1000);
											}}
										>
											下载私密接入配置（含密钥）
										</Button>
										<p className="portal-section-help">
											手动 Worker 需设置 INBOX_DOMAIN、INBOX_ORIGIN 和
											BRIDGE_KEY，源码在下载文件的 source
											字段。该文件含密钥，请妥善保存。
										</p>
									</div>
								)}
							</details>
						</>
					)}
					{tab === "test" && (
						<>
							<section className="space-y-3">
								<h3 className="portal-section-title">收信链路测试</h3>
								<p className="portal-section-help">
									生成临时地址，然后从外部邮箱发一封邮件到该地址。检测只验证邮件到达本站，测试信不会写入正式邮箱；正式入库记录在状态页单独显示。
								</p>
								<Button
									variant="secondary"
									disabled={busy}
									onClick={() =>
										void action(async () => {
											setProbe(await api.domainProbe(d.name));
											setProbeResult("");
										}, "测试地址已生成，30 分钟内有效")
									}
								>
									生成收信测试地址
								</Button>
								{probe && (
									<>
										<Input
											label="请从外部邮箱发送至"
											value={probe.address}
											readOnly
											onFocus={(e) => e.target.select()}
										/>
										<Button
											variant="ghost"
											size="sm"
											disabled={busy || dirty}
											onClick={() =>
												void action(async () => {
													const r = await api.domainProbeStatus(d.name);
													setProbeResult(
														r?.received_at
															? `已到达本站：${new Date(r.received_at).toLocaleString("zh-CN")}`
															: "尚未收到，或测试地址已过期。",
													);
												})
											}
										>
											检查是否收到
										</Button>
										{probeResult && (
											<p role="status" className="text-xs">
												{probeResult}
											</p>
										)}
									</>
								)}
							</section>
							<form
								className="space-y-4 border-t border-kumo-line pt-5"
								onSubmit={(e) => {
									e.preventDefault();
									if (window.confirm(`向 ${to} 发送一封真实配置测试邮件？`))
										void action(async () => {
											const r = await api.domainTestSend(d.name, from, to);
											await health.refetch();
											setMessage(r.note);
										}, "服务已接受测试邮件，请在收件方确认投递和 SPF/DKIM/DMARC 结果");
								}}
							>
								<h3 className="portal-section-title">发信测试</h3>
								<Input
									label="此域名已创建的发件地址"
									type="email"
									placeholder={`hello@${d.name}`}
									value={from}
									onChange={(e) => setFrom(e.target.value)}
									required
								/>
								<Input
									label="你控制的外部测试收件邮箱"
									type="email"
									value={to}
									onChange={(e) => setTo(e.target.value)}
									required
								/>
								<p className="portal-section-help">
									会真实发送一封邮件并计入额度。服务接受发送不等于对方已经收到。
								</p>
								<Button type="submit" variant="primary" disabled={busy}>
									发送测试邮件
								</Button>
							</form>
						</>
					)}
				</div>
				<div className="portal-dialog-footer">
					<Button variant="secondary" onClick={close} disabled={busy}>
						关闭
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
