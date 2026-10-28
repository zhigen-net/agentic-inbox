import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { fixture } from "./helpers";
import { accountsApp } from "../workers/routes/accounts";
import { app as mailboxApp, receiveEmail } from "../workers/index";
import {
	SESSION_COOKIE,
	accountToken,
	createSession,
	digest,
	hashPassword,
	sessionPrincipal,
} from "../workers/domain/accounts";
import {
	assertSender,
	changeAddresses,
	createMailbox,
	deliveredMailbox,
	ensureLegacyDirectory,
	mailboxAddresses,
} from "../workers/domain/mailboxes";
import type { MailboxContext } from "../workers/lib/mailbox";
import type { Principal } from "../workers/lib/auth";

function client(f: ReturnType<typeof fixture>, bridge?: Principal) {
	const app = new Hono<MailboxContext>();
	app.onError((e, c) =>
		e instanceof HTTPException
			? c.json({ error: e.message }, e.status)
			: e instanceof ZodError
				? c.json({ error: "参数错误" }, 400)
				: c.json({ error: e.message }, 500),
	);
	app.use("*", async (c, next) => {
		const p = await sessionPrincipal(c.env, getCookie(c, SESSION_COOKIE));
		if (p || bridge) c.set("principal", (p || bridge)!);
		await next();
	});
	app.route("/", accountsApp);
	app.use("/api/v1/*", async (c, next) => {
		if (!c.var.principal) return c.json({ error: "unauthorized" }, 401);
		await next();
	});
	app.route("/", mailboxApp);
	return (path: string, body?: unknown, cookie?: string, method?: string) =>
		app.request(
			"https://inbox.test" + path,
			{
				method: method || (body ? "POST" : "GET"),
				headers: {
					"Content-Type": "application/json",
					...(cookie ? { Cookie: cookie } : {}),
				},
				...(body ? { body: JSON.stringify(body) } : {}),
			},
			f.env,
			{ waitUntil() {} } as ExecutionContext,
		);
}
const cookieOf = (response: Response) =>
	response.headers
		.getSetCookie()
		.find((x) => x.startsWith(SESSION_COOKIE + "="))
		?.split(";")[0] || "";
const password = "Long unique passphrase 2026";
async function seedDomain(f: ReturnType<typeof fixture>, name: string) {
	f.sqlite
		.prepare(
			"INSERT OR IGNORE INTO domains(name,receive_enabled,send_enabled) VALUES (?,1,1)",
		)
		.run(name);
}

test("原生登录：密码校验、HttpOnly 会话、错误密码、退出和停用账户即时失效", async () => {
	const f = fixture(),
		user = f.user("member");
	f.sqlite
		.prepare("UPDATE users SET password_hash=? WHERE id=?")
		.run(await hashPassword(password), user.userId);
	const request = client(f);
	assert.equal(
		(await request("/api/auth/login", { email: user.email, password: "wrong" }))
			.status,
		401,
	);
	const login = await request("/api/auth/login", {
		email: user.email,
		password,
	});
	assert.equal(login.status, 200);
	assert.match(login.headers.getSetCookie().join(";"), /HttpOnly/);
	assert.match(login.headers.getSetCookie().join(";"), /Secure/);
	const cookie = cookieOf(login);
	assert.ok(cookie);
	assert.equal((await request("/api/v1/me", undefined, cookie)).status, 200);
	assert.equal((await request("/api/v1/me")).status, 401);
	assert.equal((await request("/api/auth/logout", {}, cookie)).status, 200);
	assert.equal((await request("/api/v1/me", undefined, cookie)).status, 401);
	const second = cookieOf(
		await request("/api/auth/login", { email: user.email, password }),
	);
	f.sqlite.prepare("UPDATE users SET active=0 WHERE id=?").run(user.userId);
	assert.equal((await request("/api/v1/me", undefined, second)).status, 401);
});
test("邀请激活绑定指定邮箱，链接一次有效；不能自行注册为管理员", async () => {
	const f = fixture(),
		u = f.user("invited");
	const token = await accountToken(f.env, u.userId, "invite"),
		request = client(f);
	assert.equal(
		(
			await request("/api/auth/register", {
				email: "other@example.test",
				password,
				token,
			})
		).status,
		400,
	);
	const result = await request("/api/auth/register", {
		email: u.email,
		password,
		token,
	});
	assert.equal(result.status, 200);
	assert.ok(cookieOf(result));
	assert.equal(
		(await request("/api/auth/register", { email: u.email, password, token }))
			.status,
		400,
	);
	assert.equal(
		(
			await request("/api/auth/register", {
				email: "admin@example.test",
				password,
			})
		).status,
		403,
	);
});
test("审核注册不会自动获得权限，批准后可独立登录", async () => {
	const f = fixture(),
		admin = f.user("admin", "admin@example.test", "admin");
	f.sqlite
		.prepare(
			"UPDATE app_settings SET value='approval' WHERE key='registration_mode'",
		)
		.run();
	const request = client(f),
		email = "new@example.test";
	const created = await request("/api/auth/register", { email, password });
	assert.equal(created.status, 201);
	assert.equal((await created.json()).pending, true);
	assert.equal(
		(await request("/api/auth/login", { email, password })).status,
		401,
	);
	const user = f.sqlite
		.prepare("SELECT id,role,can_create_mailboxes FROM users WHERE email=?")
		.get(email)!;
	assert.equal(user.role, "member");
	assert.equal(user.can_create_mailboxes, 0);
	const manage = client(f, admin);
	assert.equal(
		(
			await manage(
				"/api/v1/admin/users/" + user.id,
				{ role: "member", active: true },
				undefined,
				"PUT",
			)
		).status,
		200,
	);
	const login = await request("/api/auth/login", { email, password });
	assert.equal(login.status, 200);
	assert.deepEqual(
		await (
			await request("/api/v1/mailboxes", undefined, cookieOf(login))
		).json(),
		[],
	);
});
test("管理员初始化需要独立凭据，密码设置后不可再次执行，也不能抢注配置的管理员邮箱", async () => {
	const f = fixture();
	f.env.BOOTSTRAP_TOKEN = "x".repeat(48);
	const request = client(f);
	assert.equal(
		(
			await request("/api/auth/bootstrap", {
				email: "admin@example.test",
				password,
				token: "z".repeat(48),
			})
		).status,
		403,
	);
	assert.equal(
		(
			await request("/api/auth/bootstrap", {
				email: "admin@example.test",
				password,
				token: "x".repeat(48),
			})
		).status,
		200,
	);
	assert.equal(
		(
			await request("/api/auth/bootstrap", {
				email: "admin@example.test",
				password,
				token: "x".repeat(48),
			})
		).status,
		409,
	);
});
test("密码重置链接过期和复用被拒绝；改密和重置撤销已有会话", async () => {
	const f = fixture(),
		u = f.user("u");
	f.sqlite
		.prepare("UPDATE users SET password_hash=? WHERE id=?")
		.run(await hashPassword(password), u.userId);
	const request = client(f),
		login = await request("/api/auth/login", { email: u.email, password }),
		cookie = cookieOf(login);
	assert.equal(
		(
			await request(
				"/api/auth/password",
				{ password: "Changed password 2026", currentPassword: "wrong" },
				cookie,
			)
		).status,
		403,
	);
	const token = await accountToken(f.env, u.userId, "reset");
	const reset = await request("/api/auth/reset", {
		token,
		password: "Changed password 2026",
	});
	assert.equal(reset.status, 200);
	assert.equal((await request("/api/v1/me", undefined, cookie)).status, 401);
	assert.equal(
		(await request("/api/auth/reset", { token, password })).status,
		400,
	);
	assert.equal(
		(await request("/api/auth/login", { email: u.email, password })).status,
		401,
	);
	assert.equal(
		(
			await request("/api/auth/login", {
				email: u.email,
				password: "Changed password 2026",
			})
		).status,
		200,
	);
	const expired = await accountToken(f.env, u.userId, "reset");
	f.sqlite.prepare("UPDATE account_tokens SET expires_at=0").run();
	assert.equal(
		(await request("/api/auth/reset", { token: expired, password })).status,
		400,
	);
});
test("登录限流在共享数据库中生效；注册请求有大小上限", async () => {
	const f = fixture(),
		request = client(f);
	for (let i = 0; i < 10; i++)
		assert.equal(
			(
				await request("/api/auth/login", {
					email: "nobody@example.test",
					password,
				})
			).status,
			401,
		);
	assert.equal(
		(
			await request("/api/auth/login", {
				email: "nobody@example.test",
				password,
			})
		).status,
		429,
	);
	assert.equal(
		(
			await request("/api/auth/register", {
				email: "nobody@example.test",
				password,
				extra: "x".repeat(10000),
			})
		).status,
		413,
	);
});
test("多选域名生成同前缀地址并指向一个存储键；默认地址可修改，邮件不搬迁", async () => {
	const f = fixture(),
		admin = f.user("admin", "admin@example.test", "admin");
	await ensureLegacyDirectory(f.env);
	const box = await createMailbox(f.env, admin, {
		name: "销售邮箱",
		prefix: "sales",
		domains: ["ie8.net", "other.test"],
		defaultAddress: "sales@other.test",
	});
	assert.equal(box.email, "sales@other.test");
	assert.equal(box.addresses.length, 2);
	assert.equal(await deliveredMailbox(f.env, "sales@ie8.net"), box.id);
	assert.equal(await deliveredMailbox(f.env, "sales@other.test"), box.id);
	await assertSender(f.env, box.id, "sales@other.test");
	await assert.rejects(assertSender(f.env, box.id, "outside@ie8.net"));
	await f
		.stub(box.id)
		.createEmail("inbox", { id: "old-message", subject: "历史邮件" }, []);
	await changeAddresses(f.env, admin, box.id, {
		defaultAddress: "sales@ie8.net",
	});
	assert.equal(f.mail.get(box.id)?.get("old-message")?.subject, "历史邮件");
	assert.ok(f.objects.has(`mailboxes/${box.id}.json`));
});
test("地址冲突整体回滚；用户自建需域名授权，配额在数据库事务中执行，保留名称不可抢占", async () => {
	const f = fixture(),
		u = f.user("creator"),
		admin = f.user("admin", "admin@example.test", "admin");
	await ensureLegacyDirectory(f.env);
	await assert.rejects(
		createMailbox(f.env, u, {
			name: "Sales",
			prefix: "sales",
			domains: ["ie8.net"],
		}),
		/权限/,
	);
	f.sqlite
		.prepare(
			"UPDATE users SET can_create_mailboxes=1,mailbox_limit=1 WHERE id=?",
		)
		.run(u.userId);
	await assert.rejects(
		createMailbox(f.env, u, {
			name: "Sales",
			prefix: "sales",
			domains: ["ie8.net"],
		}),
		/权限/,
	);
	f.sqlite
		.prepare("INSERT INTO user_domains(user_id,domain) VALUES (?,?)")
		.run(u.userId, "ie8.net");
	await assert.rejects(
		createMailbox(f.env, u, {
			name: "Admin",
			prefix: "admin",
			domains: ["ie8.net"],
		}),
		/管理员/,
	);
	await createMailbox(f.env, u, {
		name: "Sales",
		prefix: "sales",
		domains: ["ie8.net"],
	});
	await assert.rejects(
		createMailbox(f.env, u, {
			name: "Service",
			prefix: "service",
			domains: ["ie8.net"],
		}),
		/上限/,
	);
	await createMailbox(f.env, admin, {
		name: "Assigned",
		prefix: "assigned",
		domains: ["ie8.net"],
		ownerId: u.userId,
	});
	f.mailbox("collision@other.test");
	await assert.rejects(
		createMailbox(f.env, admin, {
			name: "Conflict",
			prefix: "collision",
			domains: ["ie8.net", "other.test"],
		}),
		/占用/,
	);
	assert.equal(
		f.sqlite
			.prepare(
				"SELECT address FROM mailboxes WHERE address='collision@ie8.net'",
			)
			.get(),
		undefined,
	);
	assert.equal(f.objects.has("mailboxes/collision@ie8.net.json"), false);
});
test("地址停用保留占用权，默认地址不能直接停用，域名收发开关独立生效", async () => {
	const f = fixture(),
		admin = f.user("admin", "admin@example.test", "admin");
	await ensureLegacyDirectory(f.env);
	const box = await createMailbox(f.env, admin, {
		name: "Info",
		prefix: "info",
		domains: ["ie8.net", "other.test"],
	});
	await assert.rejects(
		changeAddresses(f.env, admin, box.id, { disable: ["info@ie8.net"] }),
		/默认/,
	);
	await changeAddresses(f.env, admin, box.id, { disable: ["info@other.test"] });
	assert.equal(await deliveredMailbox(f.env, "info@other.test"), null);
	await assert.rejects(
		createMailbox(f.env, admin, {
			name: "New",
			prefix: "info",
			domains: ["other.test"],
		}),
		/占用/,
	);
	await changeAddresses(f.env, admin, box.id, { enable: ["info@other.test"] });
	f.sqlite
		.prepare("UPDATE domains SET send_enabled=0 WHERE name='other.test'")
		.run();
	await assert.rejects(assertSender(f.env, box.id, "info@other.test"));
	assert.equal(await deliveredMailbox(f.env, "info@other.test"), box.id);
	await changeAddresses(f.env, admin, box.id, {
		options: [
			{ address: "info@other.test", receiveEnabled: false, sendEnabled: true },
		],
	});
	assert.equal(await deliveredMailbox(f.env, "info@other.test"), null);
});
test("旧邮箱首次访问自动补目录，停用记录不复活、原 DO/R2 映射保持不变", async () => {
	const f = fixture(),
		admin = f.user("admin", "admin@example.test", "admin");
	f.objects.set("mailboxes/legacy@ie8.net.json", '{"fromName":"旧邮箱"}');
	f.mailbox("disabled@ie8.net");
	f.sqlite
		.prepare("UPDATE mailboxes SET active=0 WHERE address='disabled@ie8.net'")
		.run();
	const original = [...f.objects.entries()];
	await ensureLegacyDirectory(f.env);
	await ensureLegacyDirectory(f.env);
	assert.equal(
		await deliveredMailbox(f.env, "legacy@ie8.net"),
		"legacy@ie8.net",
	);
	assert.equal(await deliveredMailbox(f.env, "disabled@ie8.net"), null);
	assert.deepEqual([...f.objects.entries()], original);
	const list = await (await client(f, admin)("/api/v1/mailboxes")).json();
	assert.ok(list.some((m: any) => m.id === "legacy@ie8.net"));
});
test("别名收信记录真实信封地址，且落入相同邮箱而非创建另一个 DO", async () => {
	const f = fixture(),
		admin = f.user("admin", "admin@example.test", "admin");
	await ensureLegacyDirectory(f.env);
	const box = await createMailbox(f.env, admin, {
		name: "Service",
		prefix: "service",
		domains: ["ie8.net", "other.test"],
	});
	const raw = new TextEncoder().encode(
		"From: outside@example.test\r\nTo: outsider@example.test\r\nSubject: alias\r\n\r\nBody",
	);
	const pending: Promise<unknown>[] = [];
	await receiveEmail(
		{
			to: "service@other.test",
			raw: new Blob([raw]).stream(),
			rawSize: raw.length,
			setReject() {
				throw Error("unexpected rejection");
			},
		} as ForwardableEmailMessage,
		f.env,
		{
			waitUntil(p: Promise<unknown>) {
				pending.push(p);
			},
		} as ExecutionContext,
		async () => {},
	);
	await Promise.all(pending);
	const stored = [...f.mail.get(box.id)!.values()];
	assert.equal(stored[0].delivered_to, "service@other.test");
	assert.equal(f.mail.has("service@other.test"), false);
	await receiveEmail(
		{
			to: "service@ie8.net",
			raw: new Blob([raw]).stream(),
			rawSize: raw.length,
			setReject() {
				throw Error("unexpected rejection");
			},
		} as ForwardableEmailMessage,
		f.env,
		{
			waitUntil(p: Promise<unknown>) {
				pending.push(p);
			},
		} as ExecutionContext,
		async () => {},
	);
	assert.equal(f.mail.get(box.id)!.size, 1);
});

test("发信和 AI 日额度独立执行，禁用后不能通过 API 或工具绕过", async () => {
	const f = fixture(),
		u = f.user("limited");
	f.mailbox("limited@ie8.net", { limited: "editor" });
	const { consumeQuota } = await import("../workers/domain/accounts");
	f.sqlite
		.prepare("UPDATE users SET send_limit=1,ai_limit=0 WHERE id=?")
		.run(u.userId);
	await consumeQuota(f.env, u, "send");
	await assert.rejects(consumeQuota(f.env, u, "send"));
	await assert.rejects(consumeQuota(f.env, u, "ai"));
	const response = await client(f, u)(
		"/api/v1/mailboxes/limited@ie8.net/emails",
		{},
	);
	assert.equal(response.status, 429);
});
