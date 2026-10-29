// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Banner, Button } from "@cloudflare/kumo";
import {
	FloppyDiskIcon,
	PaperPlaneTiltIcon,
	XIcon,
} from "@phosphor-icons/react";
import { useParams } from "react-router";
import { useComposeForm } from "~/hooks/useComposeForm";
import RichTextEditor from "./RichTextEditor";

export default function ComposePanel() {
	const { mailboxId, folder } = useParams<{
		mailboxId: string;
		folder: string;
	}>();

	const {
		fromAddress,
		setFromAddress,
		sendAddresses,
		to,
		setTo,
		cc,
		setCc,
		bcc,
		setBcc,
		showCcBcc,
		setShowCcBcc,
		subject,
		setSubject,
		body,
		setBody,
		error,
		isSavingDraft,
		isSending,
		formTitle,
		handleSaveDraft,
		handleSend,
		closeCompose,
		closePanel,
	} = useComposeForm(mailboxId, folder);

	return (
		<div className="flex min-w-0 flex-col h-full bg-kumo-base">
			<div className="flex items-center justify-between px-4 py-3 border-b border-kumo-line shrink-0 md:px-6">
				<h2 className="text-base font-semibold text-kumo-default">
					{formTitle}
				</h2>
				<div className="flex items-center gap-1">
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						icon={<XIcon size={18} />}
						onClick={closeCompose}
						disabled={isSending}
						aria-label="Close compose"
					/>
				</div>
			</div>

			<form
				onSubmit={(e) => handleSend(e, closePanel)}
				className="flex flex-col flex-1 min-h-0 overflow-hidden"
			>
				<div className="flex flex-1 min-h-0 flex-col overflow-y-auto px-4 md:px-6">
					{error && (
						<div className="pt-4">
							<Banner variant="error" text={error} />
						</div>
					)}
					<div className="shrink-0 divide-y divide-kumo-line">
						<div className="flex min-h-12 items-center gap-3">
							<label
								htmlFor="compose-from"
								className="w-12 shrink-0 text-sm text-kumo-subtle"
							>
								发件人
							</label>
							<select
								id="compose-from"
								aria-label="发件地址"
								value={fromAddress}
								onChange={(e) => setFromAddress(e.target.value)}
								className="min-w-0 flex-1 rounded-md border border-transparent bg-kumo-base py-2 pr-2 text-sm text-kumo-default outline-none focus:border-kumo-ring focus:ring-2 focus:ring-kumo-ring/20"
							>
								{sendAddresses.length ? (
									sendAddresses.map((a) => (
										<option key={a} value={a}>
											{a}
										</option>
									))
								) : (
									<option value="">暂无可用发件地址</option>
								)}
							</select>
						</div>
						<div className="flex min-h-12 items-center gap-3">
							<label
								htmlFor="compose-to"
								className="w-12 shrink-0 text-sm text-kumo-subtle"
							>
								收件人
							</label>
							<input
								id="compose-to"
								type="text"
								inputMode="email"
								autoComplete="off"
								placeholder="输入邮箱，多个地址用逗号分隔"
								value={to}
								onChange={(e) => setTo(e.target.value)}
								required
								className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent py-2 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-ring focus:ring-2 focus:ring-kumo-ring/20"
							/>
							{!showCcBcc && (
								<button
									type="button"
									onClick={() => setShowCcBcc(true)}
									className="shrink-0 rounded px-1 py-2 text-xs text-kumo-link hover:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-kumo-ring"
									aria-expanded={false}
								>
									抄送 / 密送
								</button>
							)}
						</div>
						{showCcBcc && (
							<>
								<div className="flex min-h-12 items-center gap-3">
									<label
										htmlFor="compose-cc"
										className="w-12 shrink-0 text-sm text-kumo-subtle"
									>
										抄送
									</label>
									<input
										id="compose-cc"
										type="text"
										inputMode="email"
										autoComplete="off"
										placeholder="多个地址用逗号分隔"
										value={cc}
										onChange={(e) => setCc(e.target.value)}
										className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent py-2 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-ring focus:ring-2 focus:ring-kumo-ring/20"
									/>
								</div>
								<div className="flex min-h-12 items-center gap-3">
									<label
										htmlFor="compose-bcc"
										className="w-12 shrink-0 text-sm text-kumo-subtle"
									>
										密送
									</label>
									<input
										id="compose-bcc"
										type="text"
										inputMode="email"
										autoComplete="off"
										placeholder="收件人不会看到密送地址"
										value={bcc}
										onChange={(e) => setBcc(e.target.value)}
										className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent py-2 text-sm text-kumo-default outline-none placeholder:text-kumo-inactive focus:border-kumo-ring focus:ring-2 focus:ring-kumo-ring/20"
									/>
								</div>
							</>
						)}
						<div className="flex min-h-12 items-center gap-3">
							<label
								htmlFor="compose-subject"
								className="w-12 shrink-0 text-sm text-kumo-subtle"
							>
								主题
							</label>
							<input
								id="compose-subject"
								type="text"
								placeholder="填写邮件主题"
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
								required
								className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent py-2 text-sm font-medium text-kumo-default outline-none placeholder:font-normal placeholder:text-kumo-inactive focus:border-kumo-ring focus:ring-2 focus:ring-kumo-ring/20"
							/>
						</div>
					</div>
					<div className="my-4 flex min-h-[240px] flex-1 flex-col">
						<RichTextEditor value={body} onChange={setBody} />
					</div>
				</div>

				{/* Footer actions */}
				<div className="mt-auto px-4 py-3 border-t border-kumo-line bg-kumo-fill/30 shrink-0 md:px-6">
					<div className="flex items-center justify-between">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={closeCompose}
							disabled={isSending}
						>
							Discard
						</Button>
						<div className="flex items-center gap-2">
							<Button
								type="button"
								variant="secondary"
								size="sm"
								loading={isSavingDraft}
								disabled={isSending}
								icon={<FloppyDiskIcon size={14} />}
								onClick={handleSaveDraft}
							>
								{isSavingDraft ? "Saving..." : "Save as Draft"}
							</Button>
							<Button
								type="submit"
								variant="primary"
								size="sm"
								loading={isSending}
								disabled={isSavingDraft || isSending}
								icon={<PaperPlaneTiltIcon size={14} />}
							>
								{isSending ? "Sending..." : "Send"}
							</Button>
						</div>
					</div>
				</div>
			</form>
		</div>
	);
}
