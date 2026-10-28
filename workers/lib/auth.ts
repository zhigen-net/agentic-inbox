import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";

export interface Principal {
	userId: string;
	email: string;
}
export interface TeamUser {
	id: string;
	email: string;
	role: "admin" | "member";
	active: number;
	status: string;
	can_create_mailboxes: number;
	mailbox_limit: number;
	send_limit: number;
	ai_limit: number;
	access_issuer?: string | null;
	access_subject?: string | null;
}
export type MailboxRole = "viewer" | "editor" | "admin";
export type MailboxAction = "read" | "write" | "manage";
export type AuthVariables = { principal: Principal };

export function directory(env: Env) {
	if (!env.DIRECTORY)
		throw new HTTPException(503, {
			message:
				"Team directory is not configured. Bind DIRECTORY and apply D1 migrations.",
		});
	return env.DIRECTORY;
}
export function configuredAdmins(env: Env): string[] {
	return (env.ADMIN_EMAILS || "")
		.split(",")
		.map((x) => x.trim().toLowerCase())
		.filter(Boolean);
}
export function allowedDomains(env: Env): string[] {
	return [
		...new Set(
			(env.DOMAINS || "")
				.split(",")
				.map((x) => x.trim().toLowerCase())
				.filter(Boolean),
		),
	];
}
export function isAllowedAddress(env: Env, address: string): boolean {
	const addresses = (env.EMAIL_ADDRESSES ?? []).map((x) => x.toLowerCase());
	return (
		allowedDomains(env).includes(address.split("@")[1]) &&
		(!addresses.length || addresses.includes(address))
	);
}

/** Access has already verified these claims. Invitations bind to one issuer/sub on first login. */
export async function resolvePrincipal(
	env: Env,
	claims: { iss?: string; sub?: string; email?: unknown },
): Promise<Principal> {
	if (
		!claims.iss ||
		!claims.sub ||
		typeof claims.email !== "string" ||
		!claims.email.includes("@")
	) {
		throw new HTTPException(403, {
			message:
				"A named Cloudflare Access user is required; service tokens are not user accounts.",
		});
	}
	const db = directory(env);
	const email = claims.email.trim().toLowerCase();
	if (configuredAdmins(env).includes(email)) {
		await db
			.prepare(
				"INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, 'admin')",
			)
			.bind(crypto.randomUUID(), email)
			.run();
	}
	await db
		.prepare(
			`UPDATE users SET access_issuer = ?, access_subject = ?
    WHERE email = ? AND active = 1 AND access_subject IS NULL AND access_issuer IS NULL`,
		)
		.bind(claims.iss, claims.sub, email)
		.run();
	const user = await db
		.prepare(
			`SELECT id, email, role, active FROM users
    WHERE email = ? AND access_issuer = ? AND access_subject = ? AND active = 1`,
		)
		.bind(email, claims.iss, claims.sub)
		.first<TeamUser>();
	if (!user)
		throw new HTTPException(403, {
			message:
				"Your account has not been invited, is disabled, or its Access identity has changed. Contact an administrator.",
		});
	return { userId: user.id, email: user.email };
}

export async function currentUser(
	env: Env,
	principal: Principal,
): Promise<TeamUser> {
	const user = await directory(env)
		.prepare(
			"SELECT id, email, role, active, status, can_create_mailboxes, mailbox_limit, send_limit, ai_limit FROM users WHERE id = ? AND active = 1 AND status = 'approved'",
		)
		.bind(principal.userId)
		.first<TeamUser>();
	if (!user)
		throw new HTTPException(403, { message: "Account disabled or not found" });
	return user;
}
export async function requireAdmin(env: Env, principal: Principal) {
	const user = await currentUser(env, principal);
	if (user.role !== "admin")
		throw new HTTPException(403, {
			message: "Administrator permission required",
		});
	return user;
}
export function permits(
	role: MailboxRole | null,
	action: MailboxAction,
): boolean {
	if (role === "admin") return true;
	return action === "read"
		? role === "viewer" || role === "editor"
		: action === "write" && role === "editor";
}
export async function authorizeMailbox(
	env: Env,
	principal: Principal,
	address: string,
	action: MailboxAction,
): Promise<MailboxRole> {
	const user = await currentUser(env, principal);
	const row = await directory(env)
		.prepare(
			`SELECT m.address, mm.role FROM mailboxes m
    LEFT JOIN mailbox_members mm ON mm.mailbox_address = m.address AND mm.user_id = ?
    WHERE m.address = ? AND m.active = 1`,
		)
		.bind(user.id, address)
		.first<{ address: string; role: "viewer" | "editor" | null }>();
	const role = row ? (user.role === "admin" ? "admin" : row.role) : null;
	// Do not disclose whether another user's mailbox exists.
	if (!role)
		throw new HTTPException(404, {
			message: "Mailbox not found or not assigned to you",
		});
	if (!permits(role, action))
		throw new HTTPException(403, {
			message: "This mailbox is read-only or requires administrator permission",
		});
	return role;
}
export async function visibleMailboxes(env: Env, principal: Principal) {
	const user = await currentUser(env, principal);
	const { ensureLegacyDirectory, mailboxAddresses } =
		await import("../domain/mailboxes");
	if (user.role === "admin") await ensureLegacyDirectory(env);
	const result =
		user.role === "admin"
			? await directory(env)
					.prepare(
						"SELECT address AS id, stable_id AS stableId, COALESCE(default_address,address) AS email, name, owner_id AS ownerId, 'admin' AS role FROM mailboxes WHERE active=1 ORDER BY name",
					)
					.all()
			: await directory(env)
					.prepare(
						`SELECT m.address AS id,m.stable_id AS stableId,COALESCE(m.default_address,m.address) AS email,m.name,m.owner_id AS ownerId,mm.role FROM mailboxes m JOIN mailbox_members mm ON mm.mailbox_address=m.address WHERE mm.user_id=? AND m.active=1 ORDER BY m.name`,
					)
					.bind(user.id)
					.all();
	return Promise.all(
		result.results.map(async (m: any) => ({
			...m,
			addresses: await mailboxAddresses(env, m.id),
			unreadCount: (
				await env.MAILBOX.get(env.MAILBOX.idFromName(m.id)).getFolders()
			)
				.filter((f: any) => f.id === "inbox")
				.reduce((sum: number, f: any) => sum + Number(f.unreadCount || 0), 0),
		})),
	);
}
export function chatIdentity(name: string): {
	principal: Principal;
	mailboxId: string;
} {
	const separator = name.indexOf("~");
	if (separator < 1)
		throw new HTTPException(403, {
			message: "A user-scoped agent is required",
		});
	return {
		principal: { userId: name.slice(0, separator), email: "" },
		mailboxId: name.slice(separator + 1),
	};
}

/** Validate the entire public Agent route before the SDK can resolve a Durable Object. */
export async function authorizeAgentPath(
	env: Env,
	principal: Principal,
	pathname: string,
) {
	const parts = pathname.split("/");
	if (parts[2] !== "email-agent" || !parts[3])
		throw new HTTPException(404, { message: "Agent not found" });
	let name: string;
	try {
		name = decodeURIComponent(parts[3]);
	} catch {
		throw new HTTPException(404, { message: "Agent not found" });
	}
	const identity = chatIdentity(name);
	if (identity.principal.userId !== principal.userId)
		throw new HTTPException(404, { message: "Agent not found" });
	// Automatic drafting is internal RPC only, never a user-controlled HTTP route.
	if (parts.slice(4).includes("onNewEmail"))
		throw new HTTPException(404, { message: "Agent not found" });
	await authorizeMailbox(env, principal, identity.mailboxId, "read");
	return identity;
}

export function authorizeTools<
	T extends Record<string, { execute: (...args: any[]) => Promise<unknown> }>,
>(
	env: Env,
	principal: Principal,
	mailboxId: string,
	tools: T,
	readTools: ReadonlySet<string>,
): T {
	for (const [name, tool] of Object.entries(tools)) {
		const execute = tool.execute;
		tool.execute = async (...args: any[]) => {
			await authorizeMailbox(
				env,
				principal,
				mailboxId,
				readTools.has(name) ? "read" : "write",
			);
			return execute(...args);
		};
	}
	return tools;
}
