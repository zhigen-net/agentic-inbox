import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { directory, currentUser, type Principal } from "../lib/auth";

export const SESSION_COOKIE = "__Host-inbox_session";
export const nowSeconds = () => Math.floor(Date.now() / 1000);
const bytes64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const un64 = (value: string) =>
	Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
export const randomToken = () =>
	bytes64(crypto.getRandomValues(new Uint8Array(32)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll("=", "");
export async function digest(value: string) {
	return bytes64(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
		),
	);
}
export async function hashPassword(password: string) {
	const salt = crypto.getRandomValues(new Uint8Array(16));
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	const result = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
		key,
		256,
	);
	return `pbkdf2:100000:${bytes64(salt)}:${bytes64(new Uint8Array(result))}`;
}
export async function verifyPassword(password: string, encoded: string | null) {
	const dummy =
		"pbkdf2:100000:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
	const [algorithm, iterations, salt, expected] = (encoded || dummy).split(":");
	if (algorithm !== "pbkdf2" || Number(iterations) !== 100000) return false;
	try {
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(password),
			"PBKDF2",
			false,
			["deriveBits"],
		);
		const result = new Uint8Array(
			await crypto.subtle.deriveBits(
				{
					name: "PBKDF2",
					salt: un64(salt),
					iterations: 100000,
					hash: "SHA-256",
				},
				key,
				256,
			),
		);
		const compare = un64(expected);
		let difference = result.length ^ compare.length;
		for (let i = 0; i < result.length; i++)
			difference |= result[i] ^ (compare[i] || 0);
		return !!encoded && difference === 0;
	} catch {
		return false;
	}
}
export async function rateLimit(
	env: Env,
	key: string,
	limit: number,
	window = 900,
) {
	const now = nowSeconds();
	const row = await directory(env)
		.prepare(
			`INSERT INTO auth_limits(key,count,expires_at) VALUES (?,1,?)
 ON CONFLICT(key) DO UPDATE SET count=CASE WHEN expires_at<=? THEN 1 ELSE count+1 END,
 expires_at=CASE WHEN expires_at<=? THEN excluded.expires_at ELSE expires_at END RETURNING count`,
		)
		.bind(key, now + window, now, now)
		.first<{ count: number }>();
	if (!row || row.count > limit)
		throw new HTTPException(429, { message: "尝试次数过多，请稍后重试" });
}
export async function createSession(
	env: Env,
	userId: string,
	expectedHash: string | null = null,
) {
	const token = randomToken(),
		now = nowSeconds();
	const result = await directory(env).batch([
		directory(env)
			.prepare("DELETE FROM sessions WHERE expires_at<=?")
			.bind(now),
		directory(env)
			.prepare(
				`INSERT INTO sessions(token_hash,user_id,expires_at,created_at,auth_version)
 SELECT ?,id,?,?,auth_version FROM users WHERE id=? AND active=1 AND status='approved' AND (? IS NULL OR password_hash=?)`,
			)
			.bind(
				await digest(token),
				now + 604800,
				now,
				userId,
				expectedHash,
				expectedHash,
			),
	]);
	if (!result[1].meta.changes)
		throw new HTTPException(401, { message: "账户状态已变化，请重新登录" });
	return token;
}
export async function sessionPrincipal(
	env: Env,
	token: string | undefined,
): Promise<Principal | null> {
	if (!token || token.length > 128) return null;
	const row = await directory(env)
		.prepare(
			`SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id
 WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND u.status='approved' AND s.auth_version=u.auth_version`,
		)
		.bind(await digest(token), nowSeconds())
		.first<{ id: string; email: string }>();
	return row ? { userId: row.id, email: row.email } : null;
}
export async function revokeSession(env: Env, token: string | undefined) {
	if (token)
		await directory(env)
			.prepare("DELETE FROM sessions WHERE token_hash=?")
			.bind(await digest(token))
			.run();
}
export async function audit(
	env: Env,
	actor: Principal | null,
	action: string,
	target: string,
	detail: unknown = {},
) {
	await directory(env)
		.prepare(
			"INSERT INTO operation_log(id,actor_id,action,target,detail) VALUES (?,?,?,?,?)",
		)
		.bind(
			crypto.randomUUID(),
			actor?.userId || null,
			action,
			target,
			JSON.stringify(detail),
		)
		.run();
}
export async function accountToken(
	env: Env,
	userId: string,
	kind: "invite" | "reset",
) {
	const token = randomToken();
	await directory(env).batch([
		directory(env)
			.prepare("DELETE FROM account_tokens WHERE user_id=? AND kind=?")
			.bind(userId, kind),
		directory(env)
			.prepare(
				"INSERT INTO account_tokens(token_hash,user_id,kind,expires_at) VALUES (?,?,?,?)",
			)
			.bind(
				await digest(token),
				userId,
				kind,
				nowSeconds() + (kind === "invite" ? 86400 : 3600),
			),
	]);
	return token;
}

export async function consumeQuota(
	env: Env,
	principal: Principal,
	kind: "send" | "ai",
) {
	const user = await currentUser(env, principal);
	const limit = kind === "send" ? user.send_limit : user.ai_limit;
	if (limit <= 0)
		throw new HTTPException(403, {
			message: kind === "send" ? "该用户未获准发信" : "该用户未获准使用 AI",
		});
	await rateLimit(
		env,
		`${kind}:${user.id}:${new Date().toISOString().slice(0, 10)}`,
		limit,
		86400,
	);
}
