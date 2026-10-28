import { bodyLimit } from "hono/body-limit";
import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import { configuredAdmins, currentUser, directory } from "../lib/auth";
import {
	SESSION_COOKIE,
	accountToken,
	audit,
	createSession,
	digest,
	hashPassword,
	nowSeconds,
	rateLimit,
	revokeSession,
	verifyPassword,
} from "../domain/accounts";

const password = z.string().min(12, "密码至少 12 位").max(128);
const emailSchema = z
	.string()
	.trim()
	.email()
	.max(254)
	.transform((x) => x.toLowerCase());
export const accountsApp = new Hono<MailboxContext>();
accountsApp.use(
	"/api/auth/*",
	bodyLimit({
		maxSize: 8192,
		onError: (c) => c.json({ error: "请求过大" }, 413),
	}),
);
accountsApp.use("/api/auth/*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	if (c.req.method !== "GET") {
		const origin = c.req.header("Origin");
		if (origin && origin !== new URL(c.req.url).origin)
			return c.json({ error: "不允许跨站请求" }, 403);
		if (Number(c.req.header("Content-Length") || 0) > 8192)
			return c.json({ error: "请求过大" }, 413);
	}
	await next();
});
function sessionCookie(c: any, token: string) {
	deleteCookie(c, "inbox_signed_out", { secure: true, path: "/" });
	setCookie(c, SESSION_COOKIE, token, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: 604800,
	});
}
async function attempt(c: any) {
	await rateLimit(
		c.env,
		`ip:${c.req.header("CF-Connecting-IP") || "local"}`,
		60,
	);
}
accountsApp.get("/api/auth/config", async (c) => {
	const mode = await directory(c.env)
		.prepare("SELECT value FROM app_settings WHERE key='registration_mode'")
		.first<{ value: string }>();
	let user: any = null;
	if (c.var.principal) {
		const u = await currentUser(c.env, c.var.principal);
		const p = await directory(c.env)
			.prepare("SELECT password_hash FROM users WHERE id=?")
			.bind(u.id)
			.first<{ password_hash: string | null }>();
		user = { ...u, hasPassword: !!p?.password_hash };
	}
	return c.json({
		registrationMode: mode?.value || "invite",
		user,
		accessBridgeAvailable: !!(c.env.POLICY_AUD && c.env.TEAM_DOMAIN),
	});
});
accountsApp.post("/api/auth/bootstrap", async (c) => {
	await attempt(c);
	const body = z
		.object({
			email: emailSchema,
			password,
			token: z.string().min(32).max(256),
		})
		.parse(await c.req.json());
	if (
		!c.env.BOOTSTRAP_TOKEN ||
		!configuredAdmins(c.env).includes(body.email) ||
		(await digest(body.token)) !== (await digest(c.env.BOOTSTRAP_TOKEN))
	)
		return c.json({ error: "初始化凭据无效" }, 403);
	const db = directory(c.env);
	if (
		await db
			.prepare(
				"SELECT id FROM users WHERE role='admin' AND password_hash IS NOT NULL",
			)
			.first()
	)
		return c.json({ error: "管理员密码已设置，初始化入口已关闭" }, 409);
	const id = crypto.randomUUID(),
		hash = await hashPassword(body.password);
	const result = await db.batch([
		db
			.prepare(
				"INSERT OR IGNORE INTO users(id,email,role) VALUES (?,?,'admin')",
			)
			.bind(id, body.email),
		db
			.prepare(
				`UPDATE users SET password_hash=?,role='admin',active=1,status='approved' WHERE email=? AND password_hash IS NULL
 AND NOT EXISTS(SELECT id FROM users WHERE role='admin' AND password_hash IS NOT NULL)`,
			)
			.bind(hash, body.email),
	]);
	if (!result[1].meta.changes)
		return c.json({ error: "初始化状态已变化，请重新登录" }, 409);
	const user = await db
		.prepare("SELECT id FROM users WHERE email=?")
		.bind(body.email)
		.first<{ id: string }>();
	sessionCookie(c, await createSession(c.env, user!.id));
	await audit(
		c.env,
		{ userId: user!.id, email: body.email },
		"account.bootstrap",
		user!.id,
	);
	return c.json({ ok: true });
});
accountsApp.post("/api/auth/login", async (c) => {
	await attempt(c);
	const body = z
		.object({ email: emailSchema, password: z.string().min(1).max(128) })
		.parse(await c.req.json());
	await rateLimit(c.env, `login:${await digest(body.email)}`, 10);
	const u = await directory(c.env)
		.prepare(
			"SELECT id,email,password_hash,active,status FROM users WHERE email=?",
		)
		.bind(body.email)
		.first<any>();
	const valid = await verifyPassword(body.password, u?.password_hash || null);
	if (!valid || !u?.active || u.status !== "approved")
		return c.json({ error: "邮箱或密码错误，或账户尚未获准使用" }, 401);
	sessionCookie(c, await createSession(c.env, u.id, u.password_hash));
	await audit(c.env, { userId: u.id, email: u.email }, "account.login", u.id);
	return c.json({ ok: true });
});
accountsApp.get("/api/auth/access-login", (c) => {
	deleteCookie(c, "inbox_signed_out", { secure: true, path: "/" });
	return c.redirect("/account");
});
accountsApp.post("/api/auth/logout", async (c) => {
	await revokeSession(c.env, getCookie(c, SESSION_COOKIE));
	deleteCookie(c, SESSION_COOKIE, { secure: true, path: "/" });
	setCookie(c, "inbox_signed_out", "1", {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
	});
	return c.json({ ok: true });
});
accountsApp.post("/api/auth/register", async (c) => {
	await attempt(c);
	const body = z
		.object({
			email: emailSchema,
			password,
			token: z.string().max(128).optional(),
		})
		.parse(await c.req.json());
	const db = directory(c.env);
	if (body.token) {
		const tokenHash = await digest(body.token);
		const token = await db
			.prepare(
				`SELECT u.id,u.email FROM account_tokens t JOIN users u ON u.id=t.user_id
   WHERE t.token_hash=? AND t.kind='invite' AND t.expires_at>? AND u.active=1 AND u.password_hash IS NULL`,
			)
			.bind(tokenHash, nowSeconds())
			.first<any>();
		if (!token || token.email !== body.email)
			return c.json({ error: "邀请链接无效或已过期" }, 400);
		const result = await db.batch([
			db
				.prepare(
					`UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=? AND password_hash IS NULL AND id IN
    (SELECT user_id FROM account_tokens WHERE token_hash=? AND kind='invite' AND expires_at>?)`,
				)
				.bind(
					await hashPassword(body.password),
					token.id,
					tokenHash,
					nowSeconds(),
				),
			db
				.prepare("DELETE FROM account_tokens WHERE token_hash=?")
				.bind(tokenHash),
		]);
		if (!result[0].meta.changes) return c.json({ error: "邀请已使用" }, 409);
		await audit(
			c.env,
			{ userId: token.id, email: token.email },
			"account.register",
			token.id,
		);
		sessionCookie(c, await createSession(c.env, token.id));
		return c.json({ ok: true });
	}
	const mode = await db
		.prepare("SELECT value FROM app_settings WHERE key='registration_mode'")
		.first<{ value: string }>();
	if (mode?.value !== "approval")
		return c.json({ error: "当前仅支持邀请注册，请联系管理员" }, 403);
	if (configuredAdmins(c.env).includes(body.email))
		return c.json({ error: "该账号须通过已有管理员身份启用" }, 403);
	const id = crypto.randomUUID();
	const result = await db
		.prepare(
			"INSERT OR IGNORE INTO users(id,email,password_hash,active,status) VALUES (?,?,?,0,'pending')",
		)
		.bind(id, body.email, await hashPassword(body.password))
		.run();
	if (!result.meta.changes)
		return c.json({ error: "无法注册此账号，请联系管理员" }, 409);
	await audit(c.env, null, "account.request-registration", id);
	return c.json({ ok: true, pending: true }, 201);
});
accountsApp.post("/api/auth/password", async (c) => {
	if (!c.var.principal) return c.json({ error: "请先登录" }, 401);
	await attempt(c);
	const body = z
		.object({ password, currentPassword: z.string().max(128).optional() })
		.parse(await c.req.json());
	const user = await currentUser(c.env, c.var.principal);
	const existing = await directory(c.env)
		.prepare("SELECT password_hash FROM users WHERE id=?")
		.bind(user.id)
		.first<{ password_hash: string | null }>();
	if (
		existing?.password_hash &&
		!(await verifyPassword(body.currentPassword || "", existing.password_hash))
	)
		return c.json({ error: "当前密码错误" }, 403);
	// 无密码的旧账户只能凭验证过的 Access 身份或受信任的现有会话进入此接口。
	await directory(c.env).batch([
		directory(c.env)
			.prepare(
				"UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=?",
			)
			.bind(await hashPassword(body.password), user.id),
		directory(c.env)
			.prepare("DELETE FROM sessions WHERE user_id=?")
			.bind(user.id),
		directory(c.env)
			.prepare("DELETE FROM account_tokens WHERE user_id=?")
			.bind(user.id),
	]);
	sessionCookie(c, await createSession(c.env, user.id));
	await audit(c.env, c.var.principal, "account.change-password", user.id);
	return c.json({ ok: true });
});
accountsApp.post("/api/auth/reset", async (c) => {
	await attempt(c);
	const body = z
		.object({ token: z.string().min(32).max(128), password })
		.parse(await c.req.json());
	const db = directory(c.env),
		hash = await digest(body.token);
	const t = await db
		.prepare(
			"SELECT user_id FROM account_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?",
		)
		.bind(hash, nowSeconds())
		.first<{ user_id: string }>();
	if (!t) return c.json({ error: "重置链接无效或已过期" }, 400);
	const result = await db.batch([
		db
			.prepare(
				`UPDATE users SET password_hash=?,auth_version=auth_version+1 WHERE id=? AND active=1 AND id IN
   (SELECT user_id FROM account_tokens WHERE token_hash=? AND kind='reset' AND expires_at>?)`,
			)
			.bind(await hashPassword(body.password), t.user_id, hash, nowSeconds()),
		db.prepare("DELETE FROM account_tokens WHERE user_id=?").bind(t.user_id),
		db.prepare("DELETE FROM sessions WHERE user_id=?").bind(t.user_id),
	]);
	if (!result[0].meta.changes) return c.json({ error: "重置链接已失效" }, 400);
	await audit(
		c.env,
		{ userId: t.user_id, email: "" },
		"account.reset-password",
		t.user_id,
	);
	return c.json({ ok: true });
});
