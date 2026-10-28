import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { fixture } from "./helpers";
import { app as api, receiveEmail } from "../workers/index";
import {
	authorizeAgentPath,
	authorizeMailbox,
	authorizeTools,
	chatIdentity,
	permits,
	resolvePrincipal,
	visibleMailboxes,
	type Principal,
} from "../workers/lib/auth";
import { handleMCP } from "../workers/mcp/index";
import type { MailboxContext } from "../workers/lib/mailbox";

function client(f: ReturnType<typeof fixture>, principal: Principal) {
	const app = new Hono<MailboxContext>();
	app.onError((err, c) =>
		err instanceof HTTPException
			? c.json({ error: err.message }, err.status)
			: err instanceof ZodError
				? c.json({ error: "Invalid request" }, 400)
				: c.json({ error: err.message }, 500),
	);
	app.use("*", async (c, next) => {
		c.set("principal", principal);
		await next();
	});
	app.route("/", api);
	return (path: string, method = "GET", body?: unknown) =>
		app.request(
			`https://inbox.test/api/v1${path}`,
			{
				method,
				...(body === undefined
					? {}
					: {
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify(body),
						}),
			},
			f.env,
			{ waitUntil() {} } as ExecutionContext,
		);
}

test("invitation binds a verified issuer/sub once, rejects uninvited, disabled and mismatched identities", async () => {
	const f = fixture();
	const claims = {
		iss: "https://access.test",
		sub: "alice-subject",
		email: "Alice@example.test",
	};
	await assert.rejects(resolvePrincipal(f.env, claims), /not been invited/);
	f.user("alice", "alice@example.test");
	assert.equal((await resolvePrincipal(f.env, claims)).userId, "alice");
	await assert.rejects(
		resolvePrincipal(f.env, { ...claims, sub: "attacker" }),
		/not been invited/,
	);
	await assert.rejects(
		resolvePrincipal(f.env, { ...claims, iss: "https://other.test" }),
		/not been invited/,
	);
	f.sqlite.prepare("UPDATE users SET active = 0 WHERE id = 'alice'").run();
	await assert.rejects(resolvePrincipal(f.env, claims), /not been invited/);
	await assert.rejects(
		resolvePrincipal(f.env, { iss: claims.iss, sub: "service" }),
		/named Cloudflare Access user/,
	);
	const admin = await resolvePrincipal(f.env, {
		...claims,
		sub: "admin-subject",
		email: "ADMIN@example.test",
	});
	assert.equal(
		(
			await f.env.DIRECTORY.prepare("SELECT role FROM users WHERE id = ?")
				.bind(admin.userId)
				.first<any>()
		).role,
		"admin",
	);
});

test("private and shared mailbox visibility, viewer/editor/admin actions and live revocation", async () => {
	const f = fixture();
	const alice = f.user("alice"),
		bob = f.user("bob"),
		admin = f.user("admin", "admin@example.test", "admin");
	f.mailbox("alice@ie8.net", { alice: "editor" });
	f.mailbox("bob@other.test", { bob: "editor" });
	f.mailbox("support@ie8.net", { alice: "editor", bob: "viewer" });
	assert.deepEqual(
		(await visibleMailboxes(f.env, bob)).map((x: any) => x.email),
		["bob@other.test", "support@ie8.net"],
	);
	assert.equal((await visibleMailboxes(f.env, admin)).length, 3);
	assert.equal(
		await authorizeMailbox(f.env, bob, "support@ie8.net", "read"),
		"viewer",
	);
	await assert.rejects(
		authorizeMailbox(f.env, bob, "support@ie8.net", "write"),
		/read-only/,
	);
	await assert.rejects(
		authorizeMailbox(f.env, bob, "alice@ie8.net", "read"),
		/not assigned/,
	);
	await assert.rejects(
		authorizeMailbox(f.env, alice, "support@ie8.net", "manage"),
		/administrator/,
	);
	assert.equal(
		await authorizeMailbox(f.env, admin, "alice@ie8.net", "manage"),
		"admin",
	);
	f.sqlite
		.prepare(
			"DELETE FROM mailbox_members WHERE user_id = 'bob' AND mailbox_address = 'support@ie8.net'",
		)
		.run();
	await assert.rejects(authorizeMailbox(f.env, bob, "support@ie8.net", "read"));
	assert.equal(permits(null, "read"), false);
	assert.deepEqual(
		chatIdentity("alice~alice@ie8.net").principal.userId,
		"alice",
	);
	assert.throws(() => chatIdentity("alice@ie8.net"), /user-scoped/);
});

test("API denies direct mailbox CRUD, nested mail, search, folders and attachment access before touching another mailbox", async () => {
	const f = fixture();
	const alice = f.user("alice");
	f.user("bob");
	f.mailbox("alice@ie8.net", { alice: "editor" });
	f.mailbox("bob@other.test", { bob: "editor" });
	const request = client(f, alice);
	assert.equal((await (await request("/mailboxes")).json()).length, 1);
	for (const [path, method] of [
		["", "GET"],
		["", "PUT"],
		["", "DELETE"],
		["/emails", "GET"],
		["/emails", "POST"],
		["/search?query=secret", "GET"],
		["/folders", "GET"],
		["/emails/e/attachments/a", "GET"],
	]) {
		assert.equal(
			(await request(`/mailboxes/bob@other.test${path}`, method)).status,
			404,
			`${method} ${path}`,
		);
	}
	assert.equal(f.calls.length, 0);
	assert.equal(
		(await request("/mailboxes", "POST", { email: "new@ie8.net", name: "new" }))
			.status,
		403,
	);
	assert.equal(
		(await request("/mailboxes/alice@ie8.net", "PUT", { settings: {} })).status,
		403,
	);
	assert.equal((await request("/admin/users")).status, 403);
	f.sqlite.prepare("UPDATE users SET active = 0 WHERE id = 'alice'").run();
	assert.equal((await request("/mailboxes")).status, 403);
});

test("viewer can read email but cannot send, draft, delete or mark read; attachments must belong to requested email", async () => {
	const f = fixture();
	const viewer = f.user("viewer");
	f.mailbox("shared@ie8.net", { viewer: "viewer" });
	await f
		.stub("shared@ie8.net")
		.createEmail("inbox", { id: "one", subject: "test" }, []);
	f.attachments.set("shared@ie8.net:attachment", {
		id: "attachment",
		email_id: "one",
		filename: "file.txt",
	});
	f.objects.set("attachments/one/attachment/file.txt", "secret file");
	const request = client(f, viewer);
	assert.equal(
		(await request("/mailboxes/shared@ie8.net/emails/one")).status,
		200,
	);
	for (const [suffix, method] of [
		["emails", "POST"],
		["drafts", "POST"],
		["emails/one", "DELETE"],
		["emails/one", "PUT"],
		["threads/t/read", "POST"],
		["folders", "POST"],
	]) {
		assert.equal(
			(await request(`/mailboxes/shared@ie8.net/${suffix}`, method, {})).status,
			403,
		);
	}
	assert.equal(
		(
			await request(
				"/mailboxes/shared@ie8.net/emails/another/attachments/attachment",
			)
		).status,
		404,
	);
	assert.equal(
		(
			await request(
				"/mailboxes/shared@ie8.net/emails/one/attachments/attachment",
			)
		).status,
		200,
	);
});

test("admin provisions configured domains only, invites and grants users; disabling retains data and revokes memberships", async () => {
	const f = fixture();
	const admin = f.user("admin", "admin@example.test", "admin");
	const request = client(f, admin);
	assert.equal(
		(
			await request("/mailboxes", "POST", {
				email: "new@evil.test",
				name: "New",
			})
		).status,
		403,
	);
	assert.equal(
		(
			await request("/mailboxes", "POST", {
				email: "new@other.test",
				name: "New",
			})
		).status,
		201,
	);
	assert.equal(
		(
			await request("/mailboxes", "POST", {
				email: "new@other.test",
				name: "New",
			})
		).status,
		409,
	);
	const invited = await (
		await request("/admin/users", "POST", { email: "teammate@example.test" })
	).json();
	assert.equal(
		(
			await request(
				`/admin/mailboxes/new@other.test/members/${invited.id}`,
				"PUT",
				{ role: "editor" },
			)
		).status,
		200,
	);
	const member = client(f, { userId: invited.id, email: invited.email });
	assert.equal((await member("/mailboxes/new@other.test")).status, 200);
	assert.equal(
		(
			await request("/admin/users/admin", "PUT", {
				role: "member",
				active: false,
			})
		).status,
		400,
	);
	assert.equal(
		(await request("/mailboxes/new@other.test", "DELETE")).status,
		204,
	);
	assert.ok(f.objects.has("mailboxes/new@other.test.json"));
	assert.equal((await member("/mailboxes/new@other.test")).status, 404);
	assert.equal(
		(await request("/admin/mailboxes/new@other.test", "PUT", { active: true }))
			.status,
		200,
	);
	assert.equal((await member("/mailboxes/new@other.test")).status, 404); // no silent re-grant
});

test("legacy import paginates, is idempotent and does not resurrect disabled mailboxes", async () => {
	const f = fixture();
	const admin = f.user("admin", "admin@example.test", "admin");
	const request = client(f, admin);
	for (let i = 0; i < 105; i++)
		f.objects.set(`mailboxes/legacy${i}@ie8.net.json`, "{}");
	f.mailbox("disabled@ie8.net");
	f.sqlite.prepare("UPDATE mailboxes SET active = 0").run();
	let cursor: string | undefined;
	do {
		const result = await (
			await request("/admin/import-mailboxes", "POST", { cursor })
		).json();
		cursor = result.cursor;
	} while (cursor);
	assert.equal(
		(
			await f.env.DIRECTORY.prepare(
				"SELECT count(*) AS n FROM mailboxes WHERE active = 1",
			).first<any>()
		).n,
		105,
	);
	await request("/admin/import-mailboxes", "POST", {});
	assert.equal(
		(
			await f.env.DIRECTORY.prepare(
				"SELECT active FROM mailboxes WHERE address = 'disabled@ie8.net'",
			).first<any>()
		).active,
		0,
	);
	assert.equal(f.objects.size, 106);
});

async function mcp(
	f: ReturnType<typeof fixture>,
	principal: Principal,
	name: string,
	args = {},
) {
	const res = await handleMCP(
		new Request("https://inbox.test/mcp", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
				"MCP-Protocol-Version": "2025-03-26",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name, arguments: args },
			}),
		}),
		f.env,
		principal,
	);
	assert.equal(res.status, 200);
	return (await res.json()).result;
}
test("MCP lists only assigned mailboxes, rejects cross-mailbox/readonly operations, and checks revocation on every request", async () => {
	const f = fixture();
	const alice = f.user("alice");
	f.user("bob");
	f.mailbox("alice@ie8.net", { alice: "viewer" });
	f.mailbox("bob@other.test", { bob: "editor" });
	const listed = await mcp(f, alice, "list_mailboxes");
	assert.deepEqual(
		JSON.parse(listed.content[0].text).map((m: any) => m.email),
		["alice@ie8.net"],
	);
	assert.equal(
		(
			await mcp(f, alice, "get_email", {
				mailboxId: "bob@other.test",
				emailId: "secret",
			})
		).isError,
		true,
	);
	assert.equal(
		(
			await mcp(f, alice, "send_email", {
				mailboxId: "alice@ie8.net",
				to: "external@example.test",
				subject: "test",
				bodyHtml: "hello",
			})
		).isError,
		true,
	);
	assert.equal(f.calls.length, 0);
	assert.equal(
		(
			await mcp(f, alice, "list_emails", {
				mailboxId: "alice@ie8.net",
				folder: "inbox",
			})
		).isError,
		undefined,
	);
	f.sqlite.prepare("DELETE FROM mailbox_members WHERE user_id = 'alice'").run();
	assert.equal(
		(
			await mcp(f, alice, "list_emails", {
				mailboxId: "alice@ie8.net",
				folder: "inbox",
			})
		).isError,
		true,
	);
});

async function deliver(
	f: ReturnType<typeof fixture>,
	envelope: string,
	raw: string,
) {
	const bytes = new TextEncoder().encode(raw);
	let rejected = "";
	const pending: Promise<unknown>[] = [];
	await receiveEmail(
		{
			to: envelope,
			raw: new Blob([bytes]).stream(),
			rawSize: bytes.length,
			setReject(reason: string) {
				rejected = reason;
			},
		} as ForwardableEmailMessage,
		f.env,
		{
			waitUntil(promise: Promise<unknown>) {
				pending.push(promise);
			},
		} as ExecutionContext,
		async (data) => {
			f.automation.push(data);
		},
	);
	await Promise.all(pending);
	return rejected;
}
test("SMTP envelope delivers CC/BCC with unrelated or missing To headers, separates domains and deduplicates exact retries", async () => {
	const f = fixture();
	f.mailbox("alice@ie8.net");
	f.mailbox("alice@other.test");
	const raw =
		"From: external@example.test\r\nTo: outsider@example.test\r\nCc: alice@ie8.net\r\nSubject: test\r\nMessage-ID: <same@example.test>\r\n\r\nBody";
	assert.equal(await deliver(f, "alice@ie8.net", raw), "");
	assert.equal(await deliver(f, "alice@other.test", raw), "");
	assert.equal(f.mail.get("alice@ie8.net")?.size, 1);
	assert.equal(f.mail.get("alice@other.test")?.size, 1);
	await deliver(f, "alice@ie8.net", raw);
	assert.equal(f.mail.get("alice@ie8.net")?.size, 1);
	assert.equal(f.automation.length, 2);
	const noTo =
		"From: external@example.test\r\nSubject: BCC\r\n\r\nHidden recipient";
	assert.equal(await deliver(f, "alice@other.test", noTo), "");
	assert.equal(f.mail.get("alice@other.test")?.size, 2);
	assert.match(await deliver(f, "missing@ie8.net", raw), /Unknown/);
	assert.match(await deliver(f, "alice@evil.test", raw), /domain/);
	f.sqlite
		.prepare("UPDATE mailboxes SET active = 0 WHERE address = 'alice@ie8.net'")
		.run();
	assert.match(await deliver(f, "alice@ie8.net", raw), /disabled/);
});

test("Agent routes cannot select another user or mailbox, and live tool execution rechecks grants", async () => {
	const f = fixture();
	const alice = f.user("alice");
	f.user("bob");
	f.mailbox("alice@ie8.net", { alice: "viewer" });
	f.mailbox("bob@other.test", { bob: "editor" });
	for (const path of [
		"/agents/email-agent/bob~bob@other.test",
		"/agents/email-agent/alice~bob@other.test",
		"/agents/email-agent/alice@ie8.net",
		"/agents/email-mcp/default",
		"/agents/email-agent/%ZZ",
		"/agents/email-agent/alice~alice@ie8.net/onNewEmail",
	]) {
		await assert.rejects(
			authorizeAgentPath(f.env, alice, path),
			undefined,
			path,
		);
	}
	assert.equal(
		(
			await authorizeAgentPath(
				f.env,
				alice,
				"/agents/email-agent/alice~alice@ie8.net/get-messages",
			)
		).mailboxId,
		"alice@ie8.net",
	);
	let reads = 0,
		writes = 0;
	const tools = authorizeTools(
		f.env,
		alice,
		"alice@ie8.net",
		{
			get_email: { execute: async () => ++reads },
			draft_reply: { execute: async () => ++writes },
		},
		new Set(["get_email"]),
	);
	await tools.get_email.execute();
	assert.equal(reads, 1);
	await assert.rejects(tools.draft_reply.execute());
	assert.equal(writes, 0);
	f.sqlite.prepare("DELETE FROM mailbox_members WHERE user_id = 'alice'").run();
	await assert.rejects(tools.get_email.execute());
	assert.equal(reads, 1);
	await assert.rejects(
		authorizeAgentPath(f.env, alice, "/agents/email-agent/alice~alice@ie8.net"),
	);
});
