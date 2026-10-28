import { accountToken, audit } from "../domain/accounts";
import { Hono } from "hono";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import {
	allowedDomains,
	configuredAdmins,
	currentUser,
	directory,
	isAllowedAddress,
	requireAdmin,
} from "../lib/auth";

export const teamApp = new Hono<MailboxContext>();
teamApp.get("/api/v1/me", async (c) =>
	c.json(await currentUser(c.env, c.var.principal)),
);
teamApp.use("/api/v1/admin/*", async (c, next) => {
	await requireAdmin(c.env, c.var.principal);
	await next();
	if (
		c.req.method !== "GET" &&
		c.res.status < 400 &&
		(c.req.path.includes("/members/") ||
			/^\/api\/v1\/admin\/mailboxes\/[^/]+$/.test(c.req.path))
	)
		await audit(c.env, c.var.principal, "mailbox." + c.req.method, c.req.path);
});
teamApp.get("/api/v1/admin/users", async (c) => {
	const users = await directory(c.env)
		.prepare(
			"SELECT id, email, role, active, status, can_create_mailboxes, mailbox_limit, send_limit, ai_limit, password_hash IS NOT NULL AS hasPassword, created_at FROM users ORDER BY email",
		)
		.all();
	return c.json(users.results);
});
teamApp.post("/api/v1/admin/users", async (c) => {
	const body = z
		.object({
			email: z.string().email(),
			role: z.enum(["admin", "member"]).default("member"),
		})
		.parse(await c.req.json());
	const email = body.email.trim().toLowerCase();
	const db = directory(c.env);
	await db
		.prepare("INSERT OR IGNORE INTO users (id, email, role) VALUES (?, ?, ?)")
		.bind(crypto.randomUUID(), email, body.role)
		.run();
	const user = await db
		.prepare("SELECT id, email, role, active FROM users WHERE email = ?")
		.bind(email)
		.first();
	const u = user as any;
	const password = await db
		.prepare("SELECT password_hash FROM users WHERE id=?")
		.bind(u.id)
		.first<any>();
	const token = password?.password_hash
		? undefined
		: await accountToken(c.env, u.id, "invite");
	await audit(c.env, c.var.principal, "user.invite", u.id);
	return c.json(
		{
			...u,
			inviteUrl: token
				? `${new URL(c.req.url).origin}/register#token=${token}&email=${encodeURIComponent(email)}`
				: undefined,
		},
		201,
	);
});
teamApp.put("/api/v1/admin/users/:userId", async (c) => {
	const body = z
		.object({ role: z.enum(["admin", "member"]), active: z.boolean() })
		.parse(await c.req.json());
	const id = c.req.param("userId");
	const user = await directory(c.env)
		.prepare("SELECT id, email FROM users WHERE id = ?")
		.bind(id)
		.first<{ id: string; email: string }>();
	if (!user) return c.json({ error: "User not found" }, 404);
	if (
		(id === c.var.principal.userId ||
			configuredAdmins(c.env).includes(user.email)) &&
		(!body.active || body.role !== "admin")
	) {
		return c.json(
			{
				error:
					"You cannot disable or demote yourself or a configured bootstrap administrator",
			},
			400,
		);
	}
	await directory(c.env)
		.prepare(
			"UPDATE users SET role = ?, active = ?, status='approved' WHERE id = ?",
		)
		.bind(body.role, Number(body.active), id)
		.run();
	if (!body.active)
		await directory(c.env)
			.prepare("DELETE FROM sessions WHERE user_id=?")
			.bind(id)
			.run();
	await audit(c.env, c.var.principal, "user.update", id, body);
	return c.json({ id, ...body });
});
teamApp.get("/api/v1/admin/mailboxes", async (c) => {
	const result = await directory(c.env)
		.prepare("SELECT address, name, active FROM mailboxes ORDER BY address")
		.all();
	return c.json(result.results);
});
teamApp.put("/api/v1/admin/mailboxes/:mailboxId", async (c) => {
	z.object({ active: z.literal(true) }).parse(await c.req.json());
	const address = c.req.param("mailboxId").toLowerCase();
	if (
		!(await directory(c.env)
			.prepare(
				`SELECT a.address FROM mailbox_addresses a JOIN domains d ON d.name=a.domain WHERE a.mailbox_address=? AND a.active=1 AND d.enabled=1`,
			)
			.bind(address)
			.first())
	)
		return c.json(
			{ error: "Address is no longer enabled in the domain configuration" },
			400,
		);
	if (!(await c.env.BUCKET.head(`mailboxes/${address}.json`)))
		return c.json({ error: "Mailbox metadata not found" }, 404);
	await directory(c.env)
		.prepare("UPDATE mailboxes SET active = 1 WHERE address = ?")
		.bind(address)
		.run();
	return c.json({ address, active: true });
});
teamApp.get("/api/v1/admin/domains", (c) =>
	c.json({ domains: allowedDomains(c.env) }),
);
teamApp.get("/api/v1/admin/mailboxes/:mailboxId/members", async (c) => {
	const result = await directory(c.env)
		.prepare(
			`SELECT u.id AS userId, u.email, u.active, mm.role
    FROM mailbox_members mm JOIN users u ON u.id = mm.user_id WHERE mm.mailbox_address = ? ORDER BY u.email`,
		)
		.bind(c.req.param("mailboxId").toLowerCase())
		.all();
	return c.json(result.results);
});
teamApp.put("/api/v1/admin/mailboxes/:mailboxId/members/:userId", async (c) => {
	const { role } = z
		.object({ role: z.enum(["viewer", "editor"]) })
		.parse(await c.req.json());
	const db = directory(c.env);
	const address = c.req.param("mailboxId").toLowerCase();
	const id = c.req.param("userId");
	const mailbox = await db
		.prepare("SELECT address FROM mailboxes WHERE address = ? AND active = 1")
		.bind(address)
		.first();
	const user = await db
		.prepare("SELECT id FROM users WHERE id = ? AND active = 1")
		.bind(id)
		.first();
	if (!mailbox || !user)
		return c.json({ error: "Mailbox or active user not found" }, 404);
	await db
		.prepare(
			`INSERT INTO mailbox_members (mailbox_address, user_id, role) VALUES (?, ?, ?)
    ON CONFLICT(mailbox_address, user_id) DO UPDATE SET role = excluded.role`,
		)
		.bind(address, id, role)
		.run();
	return c.json({ userId: id, role });
});
teamApp.delete(
	"/api/v1/admin/mailboxes/:mailboxId/members/:userId",
	async (c) => {
		await directory(c.env)
			.prepare(
				"DELETE FROM mailbox_members WHERE mailbox_address = ? AND user_id = ?",
			)
			.bind(c.req.param("mailboxId").toLowerCase(), c.req.param("userId"))
			.run();
		return c.body(null, 204);
	},
);
// Import one page at a time. The old DO names and R2 objects are preserved.
teamApp.post("/api/v1/admin/import-mailboxes", async (c) => {
	const { cursor } = z
		.object({ cursor: z.string().optional() })
		.parse(await c.req.json());
	const page = await c.env.BUCKET.list({
		prefix: "mailboxes/",
		limit: 100,
		cursor,
	});
	const statements: D1PreparedStatement[] = [];
	for (const obj of page.objects) {
		const address = obj.key.slice("mailboxes/".length, -".json".length);
		if (
			!obj.key.endsWith(".json") ||
			!z.string().email().safeParse(address).success
		)
			continue;
		statements.push(
			directory(c.env)
				.prepare(
					"INSERT OR IGNORE INTO domains(name,receive_enabled,send_enabled) VALUES (?,1,1)",
				)
				.bind(address.split("@")[1]),
			directory(c.env)
				.prepare(
					"INSERT OR IGNORE INTO mailboxes(address,name,stable_id,default_address) VALUES (?,?,?,?)",
				)
				.bind(address, address, crypto.randomUUID(), address),
			directory(c.env)
				.prepare(
					"INSERT OR IGNORE INTO mailbox_addresses(address,mailbox_address,domain) VALUES (?,?,?)",
				)
				.bind(address, address, address.split("@")[1]),
		);
	}
	if (statements.length) await directory(c.env).batch(statements);
	return c.json({
		scanned: page.objects.length,
		cursor: page.truncated ? page.cursor : undefined,
		complete: !page.truncated,
	});
});
