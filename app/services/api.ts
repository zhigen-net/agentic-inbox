// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import type { Email, Folder, Mailbox } from "~/types";

const REQUEST_TIMEOUT_MS = 30_000;

export class ApiError extends Error {
	status: number;
	body: Record<string, unknown>;

	constructor(status: number, body: Record<string, unknown>) {
		super((body.error as string) || `Request failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.body = body;
	}
}

async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	// Combine caller signal (e.g. TanStack Query abort) with our timeout signal
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;

	try {
		const res = await fetch(url, {
			...options,
			signal,
			headers: {
				"Content-Type": "application/json",
				...(options.headers as Record<string, string>),
			},
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			throw new ApiError(res.status, body as Record<string, unknown>);
		}

		if (res.status === 204) return undefined as T;

		const contentType = res.headers.get("content-type") ?? "";
		if (contentType.includes("application/json")) {
			return res.json() as Promise<T>;
		}
		return res.blob() as unknown as T;
	} finally {
		clearTimeout(timeout);
	}
}

function get<T>(
	url: string,
	opts?: {
		params?: Record<string, string>;
		responseType?: string;
		signal?: AbortSignal;
	},
) {
	const query = opts?.params ? `?${new URLSearchParams(opts.params)}` : "";
	return request<T>(`${url}${query}`, {
		method: "GET",
		signal: opts?.signal,
		...(opts?.responseType === "blob" ? { headers: { Accept: "*/*" } } : {}),
	});
}

function post<T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) {
	return request<T>(url, {
		method: "POST",
		signal: opts?.signal,
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function put<T>(url: string, body?: unknown) {
	return request<T>(url, {
		method: "PUT",
		body: body != null ? JSON.stringify(body) : undefined,
	});
}

function del<T>(url: string) {
	return request<T>(url, { method: "DELETE" });
}

// ---------- Typed response shapes ----------

interface EmailListResponse {
	emails: Email[];
	totalCount: number;
}

// ---------- API client ----------

export interface TeamUser {
	id: string;
	email: string;
	role: "admin" | "member";
	active: number;
	status?: string;
	can_create_mailboxes?: number;
	mailbox_limit?: number;
	send_limit?: number;
	ai_limit?: number;
	hasPassword?: boolean;
}
export interface MailboxMember {
	userId: string;
	email: string;
	active: number;
	role: "viewer" | "editor";
}
export interface Domain {
	name: string;
	enabled: number;
	receive_enabled: number;
	send_enabled: number;
	mx_verified: number;
	checked_at?: string;
}
export interface TeamMailbox {
	address: string;
	name: string;
	active: number;
}
const api = {
	bootstrap: (email: string, password: string, token: string) =>
		post("/api/auth/bootstrap", { email, password, token }),
	authConfig: () =>
		get<{
			registrationMode: string;
			accessBridgeAvailable: boolean;
			user: (TeamUser & { hasPassword: boolean }) | null;
		}>("/api/auth/config"),
	login: (email: string, password: string) =>
		post("/api/auth/login", { email, password }),
	register: (email: string, password: string, token?: string) =>
		post<{ ok: boolean; pending?: boolean }>("/api/auth/register", {
			email,
			password,
			token,
		}),
	logout: () => post("/api/auth/logout"),
	changePassword: (password: string, currentPassword?: string) =>
		post("/api/auth/password", { password, currentPassword }),
	resetPassword: (token: string, password: string) =>
		post("/api/auth/reset", { token, password }),
	createMultiMailbox: (data: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", data),
	getRegistrationSettings: () =>
		get<{ registrationMode: string }>("/api/v1/admin/settings"),
	setRegistrationMode: (registrationMode: string) =>
		put("/api/v1/admin/settings", { registrationMode }),
	resetLink: (id: string) =>
		post<{ url: string }>(`/api/v1/admin/users/${id}/reset-link`),
	getUserPermissions: (id: string) =>
		get<{ domains: string[] }>(`/api/v1/admin/users/${id}/permissions`),
	setUserPermissions: (id: string, data: unknown) =>
		put(`/api/v1/admin/users/${id}/permissions`, data),
	listDomains: () => get<Domain[]>("/api/v1/admin/domains/manage"),
	addDomain: (name: string) => post("/api/v1/admin/domains/manage", { name }),
	updateDomain: (name: string, data: unknown) =>
		put(`/api/v1/admin/domains/manage/${encodeURIComponent(name)}`, data),
	checkDomain: (name: string) =>
		post<{ mxVerified: boolean; note: string }>(
			`/api/v1/admin/domains/manage/${encodeURIComponent(name)}/check`,
		),
	changeAddresses: (mailboxId: string, data: unknown) =>
		put(
			`/api/v1/admin/mailboxes/${encodeURIComponent(mailboxId)}/addresses`,
			data,
		),
	operations: () => get<any[]>("/api/v1/admin/operations"),
	getMe: () => get<TeamUser>("/api/v1/me"),
	listUsers: () => get<TeamUser[]>("/api/v1/admin/users"),
	inviteUser: (email: string, role: "admin" | "member") =>
		post<TeamUser & { inviteUrl?: string }>("/api/v1/admin/users", {
			email,
			role,
		}),
	updateUser: (id: string, role: "admin" | "member", active: boolean) =>
		put(`/api/v1/admin/users/${id}`, { role, active }),
	listTeamMailboxes: () => get<TeamMailbox[]>("/api/v1/admin/mailboxes"),
	restoreMailbox: (address: string) =>
		put(`/api/v1/admin/mailboxes/${encodeURIComponent(address)}`, {
			active: true,
		}),
	listMailboxMembers: (address: string) =>
		get<MailboxMember[]>(
			`/api/v1/admin/mailboxes/${encodeURIComponent(address)}/members`,
		),
	assignMailbox: (address: string, id: string, role: "viewer" | "editor") =>
		put(
			`/api/v1/admin/mailboxes/${encodeURIComponent(address)}/members/${id}`,
			{ role },
		),
	revokeMailbox: (address: string, id: string) =>
		del(`/api/v1/admin/mailboxes/${encodeURIComponent(address)}/members/${id}`),
	importMailboxes: (
		cursor?: string,
	): Promise<{ scanned: number; complete: boolean; cursor?: string }> =>
		post("/api/v1/admin/import-mailboxes", { cursor }),
	// Config
	getConfig: () =>
		get<{
			domains: string[];
			emailAddresses: string[];
			canCreate: boolean;
			mailboxLimit: number;
		}>("/api/v1/config"),

	// Mailboxes
	listMailboxes: () => get<Mailbox[]>("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: unknown) =>
		post<Mailbox>("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		get<Mailbox>(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: unknown) =>
		put<Mailbox>(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	deleteMailbox: (mailboxId: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}`),

	// Emails
	listEmails: (
		mailboxId: string,
		params: Record<string, string>,
		opts?: { signal?: AbortSignal },
	) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/emails`, {
			params,
			signal: opts?.signal,
		}),
	sendEmail: (mailboxId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string, opts?: { signal?: AbortSignal }) =>
		get<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, {
			signal: opts?.signal,
		}),
	updateEmail: (mailboxId: string, id: string, data: unknown) =>
		put<Email>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, {
			folderId,
		}),
	getThread: (
		mailboxId: string,
		threadId: string,
		opts?: { signal?: AbortSignal },
	) =>
		get<Email[]>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}`, {
			signal: opts?.signal,
		}),
	markThreadRead: (mailboxId: string, threadId: string) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/threads/${threadId}/read`),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		get<Blob>(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`,
			{ responseType: "blob" },
		),
	saveDraft: (
		mailboxId: string,
		draft: {
			from?: string;
			to?: string;
			cc?: string;
			bcc?: string;
			subject?: string;
			body: string;
			in_reply_to?: string;
			thread_id?: string;
			draft_id?: string;
		},
	) =>
		post<{ draft_id: string }>(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	replyToEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`, email),
	forwardEmail: (mailboxId: string, emailId: string, email: unknown) =>
		post<void>(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`,
			email,
		),

	// Folders
	listFolders: (mailboxId: string) =>
		get<Folder[]>(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		post<Folder>(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		put<Folder>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		del<void>(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: Record<string, string>) =>
		get<EmailListResponse | Email[]>(`/api/v1/mailboxes/${mailboxId}/search`, {
			params,
		}),
};

export default api;
