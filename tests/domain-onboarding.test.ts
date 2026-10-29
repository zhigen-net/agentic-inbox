import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import { fixture } from "./helpers";
import { domainApp } from "../workers/routes/domain-onboarding";
import { ingressApp } from "../workers/routes/ingress";
import { domainRow, inspectDomain } from "../workers/domain/domain-health";
import {
	seal,
	unseal,
	signature,
	digest,
} from "../workers/domain/infrastructure";
import { relaySource } from "../workers/domain/relay";
import { sendEmail } from "../workers/email-sender";
import type { MailboxContext } from "../workers/lib/mailbox";
const account = "a".repeat(32),
	zone = "b".repeat(32),
	token = "test-only-token-not-a-real-credential";
function setup() {
	const f = fixture();
	f.env.DOMAIN_CONFIG_KEY = "test-only-encryption-key".repeat(3);
	f.env.INBOX_ACCOUNT_ID = account;
	f.env.INBOX_WORKER_NAME = "inbox-test";
	const principal = f.user("admin", "admin@example.test", "admin");
	f.mailbox("hello@ie8.net");
	f.objects.set(
		"mailboxes/hello@ie8.net.json",
		JSON.stringify({ autoDraftEnabled: false }),
	);
	const app = new Hono<MailboxContext>();
	app.onError((e, c) =>
		c.json(
			{ error: e.message },
			e instanceof HTTPException ? e.status : e instanceof ZodError ? 400 : 500,
		),
	);
	app.use("*", async (c, next) => {
		c.set("principal", principal);
		await next();
	});
	app.route("/", domainApp);
	app.route("/", ingressApp);
	const request = (path: string, method = "GET", body?: unknown) =>
		app.request(
			"https://inbox.test" + path,
			{
				method,
				headers: { "Content-Type": "application/json" },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			},
			f.env,
			{ waitUntil() {} } as ExecutionContext,
		);
	return { ...f, request, app };
}
async function connect(
	f: ReturnType<typeof setup>,
	provider = "cloudflare",
	accountId = account,
) {
	const r = await f.request("/api/v1/admin/domain-connections", "POST", {
		name: "test",
		provider,
		accountId: provider === "cloudflare" ? accountId : undefined,
		token,
	});
	assert.equal(r.status, 201, await r.clone().text());
	const { id } = (await r.json()) as any;
	f.sqlite
		.prepare("UPDATE domains SET connection_id=? WHERE name=?")
		.run(provider === "cloudflare" ? id : null, "ie8.net");
	return id;
}
function network(
	options: {
		mx?: string[];
		spf?: string[];
		denied?: boolean;
		foreign?: boolean;
		wrongZone?: boolean;
		notConfigured?: boolean;
	} = {},
) {
	const original = globalThis.fetch;
	const writes: { path: string; body: any; method: string }[] = [];
	let enabled = true;
	let catchAll: any = {
		enabled: false,
		actions: [],
		matchers: [{ type: "all" }],
	};
	if (options.foreign)
		catchAll = {
			enabled: true,
			actions: [{ type: "forward", value: ["elsewhere@example.test"] }],
		};
	globalThis.fetch = async (input: any, init?: any) => {
		const u = new URL(typeof input === "string" ? input : input.url);
		if (u.hostname === "cloudflare-dns.com") {
			const type = u.searchParams.get("type"),
				name = u.searchParams.get("name")!;
			let answer: any[] = [];
			if (type === "MX")
				answer = (options.mx ?? ["10 route1.mx.cloudflare.net."]).map(
					(data) => ({ type: 15, data }),
				);
			if (type === "NS")
				answer = [{ type: 2, data: "test.ns.cloudflare.com." }];
			if (type === "TXT" && !name.startsWith("_"))
				answer = (
					options.spf ?? ['"v=spf1 include:_spf.mx.cloudflare.net ~all"']
				).map((data) => ({ type: 16, data }));
			if (type === "TXT" && name.startsWith("_dmarc"))
				answer = [{ type: 16, data: '"v=DMARC1; p=none"' }];
			return Response.json({ Status: 0, Answer: answer });
		}
		assert.equal(u.hostname, "api.cloudflare.com");
		assert.equal(init?.headers.Authorization, "Bearer " + token);
		const p = u.pathname.replace("/client/v4", "");
		if (options.denied && p.includes("/email/"))
			return Response.json({ success: false }, { status: 403 });
		if (
			options.notConfigured &&
			p.includes("/email/") &&
			!p.endsWith("/dns") &&
			(!init?.method || init.method === "GET")
		)
			return Response.json({ success: false }, { status: 404 });
		let result: any;
		if (p === "/zones" || p === "/zones/" + zone) {
			const v = {
				id: zone,
				name: options.wrongZone ? "other.test" : "ie8.net",
				account: { id: account },
				status: "active",
			};
			result = p === "/zones" ? [v] : v;
		} else if (p.endsWith("/email/routing/dns"))
			result = [
				{
					type: "MX",
					name: "ie8.net",
					content: "route1.mx.cloudflare.net",
					priority: 10,
				},
				{
					type: "TXT",
					name: "ie8.net",
					content: "v=spf1 include:_spf.mx.cloudflare.net ~all",
				},
			];
		else if (p.endsWith("/email/routing/rules/catch_all")) {
			if (init?.method === "PUT") catchAll = JSON.parse(init.body);
			result = catchAll;
		} else if (p.endsWith("/email/routing/rules")) result = [];
		else if (p.endsWith("/email/routing")) result = { enabled };
		else if (p.endsWith("/email/sending/subdomains"))
			result = [{ name: "ie8.net", enabled: true }];
		else throw new Error("Unexpected API " + p);
		if (init?.method && init.method !== "GET")
			writes.push({
				path: p,
				method: init.method,
				body: typeof init.body === "string" ? JSON.parse(init.body) : null,
			});
		return Response.json({ success: true, result });
	};
	return {
		writes,
		restore: () => (globalThis.fetch = original),
		setCatchAll: (value: any) => (catchAll = value),
	};
}

test("domain credentials are encrypted with context binding, never returned or audited, and restricted to administrators", async () => {
	const f = setup();
	const cid = await connect(f);
	const stored = f.sqlite
		.prepare("SELECT credential FROM provider_connections WHERE id=?")
		.get(cid) as any;
	assert.ok(!stored.credential.includes(token));
	assert.equal(await unseal(f.env, stored.credential, cid), token);
	await assert.rejects(unseal(f.env, stored.credential, "wrong-context"));
	const body = await (
		await f.request("/api/v1/admin/domain-connections")
	).text();
	assert.ok(!body.includes(token));
	assert.ok(!body.includes(stored.credential));
	assert.equal(
		(await f.request("/api/v1/admin/domain-connections/" + cid, "DELETE"))
			.status,
		409,
	);
	f.sqlite.prepare("UPDATE users SET role='member' WHERE id='admin'").run();
	assert.equal(
		(await f.request("/api/v1/admin/domain-connections")).status,
		403,
	);
	assert.ok(
		!JSON.stringify(
			f.sqlite.prepare("SELECT * FROM operation_log").all(),
		).includes(token),
	);
});
test("DNS and provider permissions produce separate honest states; a failed zone match cannot expose another domain", async () => {
	const f = setup();
	await connect(f);
	let n = network({ denied: true });
	try {
		const r = await inspectDomain(f.env, await domainRow(f.env, "ie8.net"));
		assert.equal(r.health.checks.find((x) => x.id === "mx")?.state, "passed");
		assert.equal(
			r.health.checks.find((x) => x.id === "routing")?.state,
			"permission",
		);
		assert.equal(
			r.health.checks.find((x) => x.id === "dkim")?.state,
			"unknown",
		);
		assert.equal(
			r.health.checks.find((x) => x.id === "receive_test")?.state,
			"unknown",
		);
	} finally {
		n.restore();
	}
	n = network({ wrongZone: true });
	try {
		const r = await inspectDomain(f.env, await domainRow(f.env, "ie8.net"));
		assert.equal(r.zone, null);
		assert.equal(
			r.health.checks.find((x) => x.id === "zone")?.state,
			"missing",
		);
		assert.ok(!r.health.checks.some((x) => x.id === "catch_all"));
	} finally {
		n.restore();
	}
});
test("configuration previews refuse foreign MX, conflicting SPF and existing routing targets without writes", async () => {
	for (const config of [
		{ mx: ["10 mx.example.test."] },
		{ spf: ['"v=spf1 include:another.test ~all"'] },
		{ foreign: true },
		{ denied: true },
	]) {
		const f = setup();
		await connect(f);
		const n = network(config);
		try {
			const r = await f.request(
				"/api/v1/admin/domains/manage/ie8.net/plan",
				"POST",
				{},
			);
			const p = (await r.json()) as any;
			assert.equal(r.status, 200);
			assert.ok(p.blockers.length);
			const applied = await f.request(
				"/api/v1/admin/domains/manage/ie8.net/apply",
				"POST",
				{ planId: p.id },
			);
			assert.equal(applied.status, 409);
			assert.equal(n.writes.length, 0);
		} finally {
			n.restore();
		}
	}
});
test("approved plans apply only once and recheck drift before mutating routing", async () => {
	const f = setup();
	await connect(f);
	const n = network();
	try {
		let p = (await (
			await f.request("/api/v1/admin/domains/manage/ie8.net/plan", "POST", {})
		).json()) as any;
		assert.deepEqual(p.blockers, []);
		assert.equal(n.writes.length, 0);
		assert.equal(
			(
				await f.request("/api/v1/admin/domains/manage/ie8.net/apply", "POST", {
					planId: p.id,
				})
			).status,
			200,
		);
		assert.equal(n.writes.length, 1);
		assert.equal(n.writes[0].body.actions[0].value[0], "inbox-test");
		assert.equal(
			(
				await f.request("/api/v1/admin/domains/manage/ie8.net/apply", "POST", {
					planId: p.id,
				})
			).status,
			409,
		);
		n.setCatchAll({ enabled: false, actions: [] });
		p = (await (
			await f.request("/api/v1/admin/domains/manage/ie8.net/plan", "POST", {})
		).json()) as any;
		n.setCatchAll({
			enabled: true,
			actions: [{ type: "forward", value: ["new@example.test"] }],
		});
		assert.equal(
			(
				await f.request("/api/v1/admin/domains/manage/ie8.net/apply", "POST", {
					planId: p.id,
				})
			).status,
			409,
		);
		assert.equal(n.writes.length, 1);
	} finally {
		n.restore();
	}
});
test("relay verifies HMAC, timestamp, domain and replay; reuses real alias delivery and preserves incoming MIME deduplication", async () => {
	const f = setup();
	const relay = (await (
		await f.request("/api/v1/admin/domains/manage/ie8.net/relay", "POST", {
			action: "credentials",
		})
	).json()) as any;
	const raw =
		"From: outside@example.test\r\nTo: hello@ie8.net\r\nSubject: Signed test\r\n\r\nHello";
	const timestamp = String(Math.floor(Date.now() / 1000)),
		requestId = crypto.randomUUID();
	const signatureValue = await signature(
		relay.secret,
		[
			timestamp,
			requestId,
			"outside@example.test",
			"hello@ie8.net",
			await digest(raw),
		].join("\n"),
	);
	const headers = {
		"X-Inbox-Time": timestamp,
		"X-Inbox-Id": requestId,
		"X-Inbox-From": "outside@example.test",
		"X-Inbox-To": "hello@ie8.net",
		"X-Inbox-Signature": signatureValue,
	};
	const req = (h: Record<string, string>, body = raw) =>
		f.app.request(
			"https://inbox.test/ingress/email/ie8.net",
			{ method: "POST", headers: h, body },
			f.env,
			{ waitUntil() {} } as ExecutionContext,
		);
	assert.equal(
		(await req({ ...headers, "X-Inbox-Signature": "0".repeat(64) })).status,
		401,
	);
	assert.equal(
		(await req({ ...headers, "X-Inbox-Time": "1000000000" })).status,
		401,
	);
	assert.equal(
		(await req({ ...headers, "X-Inbox-To": "hello@other.test" })).status,
		401,
	);
	assert.equal((await req(headers, raw + "tamper")).status, 401);
	assert.equal((await req(headers)).status, 200);
	assert.equal((await req(headers)).status, 200);
	assert.equal(await f.stub("hello@ie8.net").countEmails(), 1);
	assert.ok((await domainRow(f.env, "ie8.net")).last_receive_at);
});
test("receive probes verify arrival without creating a mailbox or exposing ordinary mailbox contents", async () => {
	const f = setup();
	const credentials = (await (
		await f.request("/api/v1/admin/domains/manage/ie8.net/relay", "POST", {
			action: "credentials",
		})
	).json()) as any;
	const probe = (await (
		await f.request("/api/v1/admin/domains/manage/ie8.net/probe", "POST")
	).json()) as any;
	const body = "From: test@example.test\r\nSubject: probe\r\n\r\nprobe";
	const time = String(Math.floor(Date.now() / 1000)),
		reqId = crypto.randomUUID();
	const sig = await signature(
		credentials.secret,
		[time, reqId, "test@example.test", probe.address, await digest(body)].join(
			"\n",
		),
	);
	const r = await f.app.request(
		"https://inbox.test/ingress/email/ie8.net",
		{
			method: "POST",
			headers: {
				"X-Inbox-Time": time,
				"X-Inbox-Id": reqId,
				"X-Inbox-From": "test@example.test",
				"X-Inbox-To": probe.address,
				"X-Inbox-Signature": sig,
			},
			body,
		},
		f.env,
		{ waitUntil() {} } as ExecutionContext,
	);
	assert.equal(r.status, 200, await r.clone().text());
	const result = (await (
		await f.request("/api/v1/admin/domains/manage/ie8.net/probe")
	).json()) as any;
	assert.ok(result.received_at);
	assert.equal(await f.stub("hello@ie8.net").countEmails(), 0);
	assert.equal((await domainRow(f.env, "ie8.net")).last_receive_at, null);
});
test("external sending uses a separate encrypted provider connection and never silently falls back to the default binding", async () => {
	const f = setup();
	const cid = await connect(f, "resend");
	f.sqlite
		.prepare(
			"UPDATE domains SET setup_mode='external',send_connection_id=? WHERE name='ie8.net'",
		)
		.run(cid);
	const original = globalThis.fetch;
	let requested = 0;
	globalThis.fetch = async (input: any, init?: any) => {
		assert.equal(input, "https://api.resend.com/emails");
		assert.equal(init.headers.Authorization, "Bearer " + token);
		const b = JSON.parse(init.body);
		assert.deepEqual(b.to, ["to@example.test"]);
		assert.equal(b.from, "Team <hello@ie8.net>");
		assert.equal(b.reply_to, "reply@example.test");
		requested++;
		return Response.json({ id: "provider-message" });
	};
	try {
		const r = await sendEmail(f.env, {
			from: { name: "Team", email: "hello@ie8.net" },
			to: "to@example.test",
			replyTo: "reply@example.test",
			subject: "test",
			text: "test",
		});
		assert.equal(r.messageId, "provider-message");
		assert.ok((await domainRow(f.env, "ie8.net")).last_send_at);
		f.sqlite
			.prepare(
				"UPDATE domains SET send_connection_id=NULL WHERE name='ie8.net'",
			)
			.run();
		await assert.rejects(
			sendEmail(f.env, {
				from: "hello@ie8.net",
				to: "to@example.test",
				subject: "test",
				text: "test",
			}),
			/connection is missing/,
		);
		assert.equal(requested, 1);
	} finally {
		globalThis.fetch = original;
	}
});
test("generated relay Worker signs the same wire protocol and propagates delivery failures for retries", async () => {
	const source = relaySource();
	const module = await import(
		"data:text/javascript;base64," + Buffer.from(source).toString("base64")
	);
	const original = globalThis.fetch;
	const raw = "From: hello@example.test\r\nSubject: Relay\r\n\r\nRaw";
	let calls = 0;
	globalThis.fetch = async (input: any, init?: any) => {
		calls++;
		assert.equal(input, "https://inbox.test/ingress/email/ie8.net");
		const h = init.headers;
		const data = [
			h["X-Inbox-Time"],
			h["X-Inbox-Id"],
			h["X-Inbox-From"],
			h["X-Inbox-To"],
			await digest(raw),
		].join("\n");
		assert.equal(h["X-Inbox-Signature"], await signature("relay-secret", data));
		return new Response("", { status: 503 });
	};
	try {
		await assert.rejects(
			module.default.email(
				{
					from: "hello@example.test",
					to: "hello@ie8.net",
					rawSize: raw.length,
					raw: new Blob([raw]).stream(),
					setReject() {
						throw new Error("unexpected reject");
					},
				},
				{
					INBOX_DOMAIN: "ie8.net",
					INBOX_ORIGIN: "https://inbox.test",
					BRIDGE_KEY: "relay-secret",
				},
			),
			/503/,
		);
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = original;
	}
});

test("cross-account deployment refuses unrelated Workers and uploads only domain-bound relay secrets, never API credentials", async () => {
	const f = setup();
	await connect(f, "cloudflare", "c".repeat(32));
	const original = globalThis.fetch;
	let mode = "unowned",
		writes = 0;
	globalThis.fetch = async (input: any, init?: any) => {
		const u = new URL(input);
		assert.ok(
			u.pathname.includes(
				"/accounts/" + "c".repeat(32) + "/workers/scripts/inbox-relay-",
			),
		);
		if (!init?.method || init.method === "GET") {
			return mode === "unowned"
				? Response.json({ success: true, result: { bindings: [], tags: [] } })
				: Response.json({ success: false }, { status: 404 });
		}
		assert.equal(init.method, "PUT");
		const form = init.body as FormData;
		const metadata = JSON.parse(form.get("metadata") as string);
		assert.ok(metadata.tags.includes("agentic-inbox-domain-relay"));
		assert.ok(!JSON.stringify(metadata).includes(token));
		assert.ok(
			metadata.bindings.some(
				(x: any) => x.name === "BRIDGE_KEY" && x.type === "secret_text",
			),
		);
		assert.ok(
			metadata.bindings.some(
				(x: any) => x.name === "INBOX_DOMAIN" && x.text === "ie8.net",
			),
		);
		writes++;
		return Response.json({ success: true, result: {} });
	};
	try {
		assert.equal(
			(
				await f.request("/api/v1/admin/domains/manage/ie8.net/relay", "POST", {
					action: "deploy",
				})
			).status,
			409,
		);
		assert.equal(writes, 0);
		mode = "absent";
		const r = await f.request(
			"/api/v1/admin/domains/manage/ie8.net/relay",
			"POST",
			{ action: "deploy" },
		);
		assert.equal(r.status, 200, await r.clone().text());
		assert.equal(writes, 1);
	} finally {
		globalThis.fetch = original;
	}
});

test("expired configuration previews cannot cause any provider mutations", async () => {
	const f = setup();
	await connect(f);
	const n = network();
	try {
		const p = (await (
			await f.request("/api/v1/admin/domains/manage/ie8.net/plan", "POST", {})
		).json()) as any;
		f.sqlite
			.prepare("UPDATE domain_plans SET expires_at=0 WHERE id=?")
			.run(p.id);
		assert.equal(
			(
				await f.request("/api/v1/admin/domains/manage/ie8.net/apply", "POST", {
					planId: p.id,
				})
			).status,
			409,
		);
		assert.equal(n.writes.length, 0);
	} finally {
		n.restore();
	}
});

test("an unconfigured but authorized zone can preview onboarding without treating 404 as successful verification", async () => {
	const f = setup();
	await connect(f);
	const n = network({ notConfigured: true, mx: [], spf: [] });
	try {
		const r = await f.request(
			"/api/v1/admin/domains/manage/ie8.net/plan",
			"POST",
			{ enableSending: true },
		);
		const p = (await r.json()) as any;
		assert.deepEqual(p.blockers, []);
		assert.equal(p.changes.length, 3);
		assert.equal(
			p.health.checks.find((x: any) => x.id === "routing").state,
			"missing",
		);
		assert.equal(n.writes.length, 0);
	} finally {
		n.restore();
	}
});

test("same-account read-only configuration connections preserve the original binding, and telemetry failure cannot turn an accepted send into a retry", async () => {
	const f = setup();
	await connect(f);
	let calls = 0;
	f.env.EMAIL = {
		send: async () => {
			calls++;
			return { messageId: "accepted-once" };
		},
	} as any;
	const original = globalThis.fetch,
		prepare = f.env.DIRECTORY.prepare.bind(f.env.DIRECTORY);
	globalThis.fetch = async () => {
		throw new Error("must not use API for default same-account sends");
	};
	f.env.DIRECTORY.prepare = ((sql: string) =>
		sql.includes("UPDATE domains SET last_send_at")
			? {
					bind() {
						return {
							async run() {
								throw new Error("telemetry outage");
							},
						};
					},
				}
			: prepare(sql)) as any;
	try {
		const r = await sendEmail(f.env, {
			from: "hello@ie8.net",
			to: "outside@example.test",
			subject: "test",
			text: "test",
		});
		assert.equal(r.messageId, "accepted-once");
		assert.equal(calls, 1);
	} finally {
		globalThis.fetch = original;
	}
});

test("changing the receive provider revokes old relay keys and marks older activity as historical verification", async () => {
	const f = setup();
	await f.request("/api/v1/admin/domains/manage/ie8.net/relay", "POST", {
		action: "credentials",
	});
	f.sqlite
		.prepare(
			"UPDATE domains SET last_receive_at='2000-01-01T00:00:00Z',last_send_at='2000-01-01T00:00:00Z' WHERE name='ie8.net'",
		)
		.run();
	const r = await f.request(
		"/api/v1/admin/domains/manage/ie8.net/setup",
		"PUT",
		{
			mode: "external",
			connectionId: null,
			sendConnectionId: null,
			zoneId: null,
			dkimSelector: "",
		},
	);
	assert.equal(r.status, 200, await r.clone().text());
	const row = await domainRow(f.env, "ie8.net");
	assert.equal(row.relay_key, null);
	assert.ok(row.setup_changed_at);
	const n = network();
	try {
		const report = await inspectDomain(f.env, row);
		assert.equal(
			report.health.checks.find((x) => x.id === "receive_test")?.state,
			"unknown",
		);
		assert.equal(
			report.health.checks.find((x) => x.id === "send_test")?.state,
			"unknown",
		);
	} finally {
		n.restore();
	}
});
