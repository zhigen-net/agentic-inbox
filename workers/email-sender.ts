import type { Env } from "./types";
import { connection, provider } from "./domain/infrastructure";
// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via Cloudflare Email Service binding.
 *
 * Uses the `send_email` Worker binding (`env.EMAIL.send()`) to send emails.
 *
 * See: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

/**
 * Send an email using the Cloudflare Email Service binding.
 *
 * @param binding  - The `EMAIL` SendEmail binding from env
 * @param params   - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId
 * @throws On validation or delivery errors (error has `.code` property)
 */
export async function sendEmail(
	binding: SendEmail | Env,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const message: Record<string, unknown> = {
		to: params.to,
		from: params.from,
		subject: params.subject,
	};

	if (params.html) message.html = params.html;
	if (params.text) message.text = params.text;
	if (params.cc) message.cc = params.cc;
	if (params.bcc) message.bcc = params.bcc;
	if (params.replyTo) message.replyTo = params.replyTo;

	if (params.headers && Object.keys(params.headers).length > 0) {
		message.headers = params.headers;
	}

	if (params.attachments && params.attachments.length > 0) {
		message.attachments = params.attachments.map((att) => ({
			content: att.content,
			filename: att.filename,
			type: att.type,
			disposition: att.disposition,
			...(att.contentId ? { contentId: att.contentId } : {}),
		}));
	}

	if (!("DIRECTORY" in binding)) {
		const result = await binding.send(message as any);
		return { messageId: result.messageId };
	}
	const env = binding,
		domain = (typeof params.from === "string" ? params.from : params.from.email)
			.split("@")[1]
			.toLowerCase();
	try {
		const row = await env.DIRECTORY.prepare(
			"SELECT send_connection_id,connection_id,setup_mode FROM domains WHERE name=?",
		)
			.bind(domain)
			.first<{
				send_connection_id: string | null;
				connection_id: string | null;
				setup_mode: string;
			}>();
		const receiveConnection = await connection(env, row?.connection_id || null);
		const c = await connection(
			env,
			row?.send_connection_id ||
				(receiveConnection?.provider === "cloudflare" &&
				receiveConnection.account_id !== env.INBOX_ACCOUNT_ID
					? receiveConnection.id
					: null),
		);
		let messageId: string;
		if (c) {
			const address = (v: string | { email: string; name?: string }) =>
				typeof v === "string" ? v : { address: v.email, name: v.name };
			const body: Record<string, unknown> = {
				...message,
				from: address(params.from),
			};
			delete body.replyTo;
			if (params.replyTo) body.reply_to = address(params.replyTo);
			if (c.provider === "cloudflare") {
				if (params.attachments)
					body.attachments = params.attachments.map((a) => ({
						content: a.content,
						filename: a.filename,
						type: a.type,
						disposition: a.disposition || "attachment",
						...(a.contentId ? { content_id: a.contentId } : {}),
					}));
				const r = await provider(
					env,
					c,
					`/accounts/${c.account_id}/email/sending/send`,
					"POST",
					body,
				);
				messageId = r.message_id;
				if (!r.delivered?.length && !r.queued?.length)
					throw new Error("No recipients accepted");
			} else {
				const formatted = (v: string | { email: string; name?: string }) =>
					typeof v === "string"
						? v
						: v.name
							? `${v.name.replace(/[<>\r\n]/g, "")} <${v.email}>`
							: v.email;
				body.from = formatted(params.from);
				for (const field of ["to", "cc", "bcc"] as const)
					if (params[field])
						body[field] = Array.isArray(params[field])
							? params[field]
							: [params[field]];
				if (params.replyTo) body.reply_to = formatted(params.replyTo);
				if (params.attachments)
					body.attachments = params.attachments.map((a) => ({
						content: a.content,
						filename: a.filename,
						...(a.contentId ? { content_id: a.contentId } : {}),
					}));
				const r = await provider(env, c, "/emails", "POST", body);
				messageId = r.id;
			}
		} else {
			if (row?.setup_mode === "external" || row?.send_connection_id)
				throw new Error("Sending connection is missing");
			const r = await env.EMAIL.send(message as any);
			messageId = r.messageId;
		}
		if (!messageId)
			throw new Error("Sending service did not return message ID");
		await env.DIRECTORY.prepare(
			"UPDATE domains SET last_send_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),last_send_error=NULL WHERE name=?",
		)
			.bind(domain)
			.run()
			.catch(() => {});
		return { messageId };
	} catch (e) {
		await env.DIRECTORY.prepare(
			"UPDATE domains SET last_send_error=? WHERE name=?",
		)
			.bind("最近发送尝试失败，请检查服务连接、发信域名及账户配额", domain)
			.run()
			.catch(() => {});
		throw e;
	}
}
