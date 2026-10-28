import { Hono } from "hono";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import { directory, requireAdmin } from "../lib/auth";
import { accountToken, audit } from "../domain/accounts";
import {
	changeAddresses,
	ensureLegacyDirectory,
	normalizeDomain,
} from "../domain/mailboxes";
export const managementApp = new Hono<MailboxContext>();
managementApp.use("/api/v1/admin/*", async (c, next) => {
	await requireAdmin(c.env, c.var.principal);
	await next();
});
managementApp.get("/api/v1/admin/settings", async (c) => {
	const row = await directory(c.env)
		.prepare("SELECT value FROM app_settings WHERE key='registration_mode'")
		.first<any>();
	return c.json({ registrationMode: row?.value || "invite" });
});
managementApp.put("/api/v1/admin/settings", async (c) => {
	const body = z
		.object({ registrationMode: z.enum(["closed", "invite", "approval"]) })
		.parse(await c.req.json());
	await directory(c.env)
		.prepare(
			"INSERT INTO app_settings(key,value) VALUES ('registration_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
		)
		.bind(body.registrationMode)
		.run();
	await audit(
		c.env,
		c.var.principal,
		"settings.registration",
		"registration_mode",
		body,
	);
	return c.json(body);
});
managementApp.post("/api/v1/admin/users/:id/reset-link", async (c) => {
	const user = await directory(c.env)
		.prepare("SELECT id FROM users WHERE id=? AND active=1")
		.bind(c.req.param("id"))
		.first<any>();
	if (!user) return c.json({ error: "用户不存在或已停用" }, 404);
	const token = await accountToken(c.env, user.id, "reset");
	await audit(c.env, c.var.principal, "user.reset-link", user.id);
	return c.json({
		url: `${new URL(c.req.url).origin}/reset-password#token=${token}`,
	});
});
managementApp.get("/api/v1/admin/users/:id/permissions", async (c) => {
	const domains = (
		await directory(c.env)
			.prepare("SELECT domain FROM user_domains WHERE user_id=?")
			.bind(c.req.param("id"))
			.all()
	).results.map((r: any) => r.domain);
	return c.json({ domains });
});
managementApp.put("/api/v1/admin/users/:id/permissions", async (c) => {
	const b = z
		.object({
			canCreate: z.boolean(),
			mailboxLimit: z.number().int().min(0).max(1000),
			sendLimit: z.number().int().min(0).max(10000).default(100),
			aiLimit: z.number().int().min(0).max(10000).default(50),
			domains: z.array(z.string()).max(100),
		})
		.parse(await c.req.json());
	const db = directory(c.env),
		id = c.req.param("id");
	if (!(await db.prepare("SELECT id FROM users WHERE id=?").bind(id).first()))
		return c.json({ error: "用户不存在" }, 404);
	const domains = [...new Set(b.domains.map(normalizeDomain))];
	for (const domain of domains)
		if (
			!(await db
				.prepare("SELECT name FROM domains WHERE name=?")
				.bind(domain)
				.first())
		)
			return c.json({ error: "域名不存在" }, 400);
	await db.batch([
		db
			.prepare(
				"UPDATE users SET can_create_mailboxes=?,mailbox_limit=?,send_limit=?,ai_limit=? WHERE id=?",
			)
			.bind(Number(b.canCreate), b.mailboxLimit, b.sendLimit, b.aiLimit, id),
		db.prepare("DELETE FROM user_domains WHERE user_id=?").bind(id),
		...domains.map((d) =>
			db
				.prepare("INSERT INTO user_domains(user_id,domain) VALUES (?,?)")
				.bind(id, d),
		),
	]);
	await audit(c.env, c.var.principal, "user.permissions", id, b);
	return c.json({ ok: true });
});
managementApp.get("/api/v1/admin/domains/manage", async (c) => {
	await ensureLegacyDirectory(c.env);
	return c.json(
		(
			await directory(c.env)
				.prepare("SELECT * FROM domains ORDER BY name")
				.all()
		).results,
	);
});
managementApp.post("/api/v1/admin/domains/manage", async (c) => {
	const b = z
			.object({ name: z.string().min(1).max(253) })
			.parse(await c.req.json()),
		name = normalizeDomain(b.name);
	const result = await directory(c.env)
		.prepare("INSERT OR IGNORE INTO domains(name) VALUES (?)")
		.bind(name)
		.run();
	if (!result.meta.changes) return c.json({ error: "域名已存在" }, 409);
	await audit(c.env, c.var.principal, "domain.create", name);
	return c.json({ name }, 201);
});
managementApp.put("/api/v1/admin/domains/manage/:domain", async (c) => {
	const b = z
			.object({
				enabled: z.boolean(),
				receiveEnabled: z.boolean(),
				sendEnabled: z.boolean(),
			})
			.parse(await c.req.json()),
		name = normalizeDomain(c.req.param("domain"));
	const result = await directory(c.env)
		.prepare(
			"UPDATE domains SET enabled=?,receive_enabled=?,send_enabled=? WHERE name=?",
		)
		.bind(
			Number(b.enabled),
			Number(b.receiveEnabled),
			Number(b.sendEnabled),
			name,
		)
		.run();
	if (!result.meta.changes) return c.json({ error: "域名不存在" }, 404);
	await audit(c.env, c.var.principal, "domain.update", name, b);
	return c.json({ ok: true });
});
managementApp.post("/api/v1/admin/domains/manage/:domain/check", async (c) => {
	const name = normalizeDomain(c.req.param("domain"));
	if (
		!(await directory(c.env)
			.prepare("SELECT name FROM domains WHERE name=?")
			.bind(name)
			.first())
	)
		return c.json({ error: "域名不存在" }, 404);
	const response = await fetch(
		`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=MX`,
		{
			headers: { Accept: "application/dns-json" },
			signal: AbortSignal.timeout(10000),
		},
	);
	if (!response.ok) return c.json({ error: "DNS 检测暂不可用" }, 502);
	const result = (await response.json()) as { Answer?: { data: string }[] };
	const verified = !!result.Answer?.some((a) =>
		/\broute[0-9]*\.mx\.cloudflare\.net\.?$/i.test(a.data),
	);
	await directory(c.env)
		.prepare(
			"UPDATE domains SET mx_verified=?,checked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE name=?",
		)
		.bind(Number(verified), name)
		.run();
	return c.json({
		mxVerified: verified,
		note: "MX 检测不代表发信已通过验证，仍需在 Cloudflare 配置 Email Routing 和 Email Service。",
	});
});
managementApp.put("/api/v1/admin/mailboxes/:mailboxId/addresses", async (c) =>
	c.json(
		await changeAddresses(
			c.env,
			c.var.principal,
			c.req.param("mailboxId"),
			await c.req.json(),
		),
	),
);
managementApp.get("/api/v1/admin/operations", async (c) =>
	c.json(
		(
			await directory(c.env)
				.prepare(
					"SELECT l.*,u.email AS actor_email FROM operation_log l LEFT JOIN users u ON u.id=l.actor_id ORDER BY l.created_at DESC LIMIT 100",
				)
				.all()
		).results,
	),
);
