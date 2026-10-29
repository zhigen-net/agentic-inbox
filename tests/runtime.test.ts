import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { signature, digest } from "../workers/domain/infrastructure";

test(
	"workerd: actual D1, Mailbox DO idempotency/rollback, user-scoped Agent history and live WebSocket revocation",
	{ timeout: 45000 },
	async () => {
		const compiled = await build({
			entryPoints: [new URL("runtime-worker.ts", import.meta.url).pathname],
			bundle: true,
			write: false,
			format: "esm",
			platform: "neutral",
			define: {
				"import.meta.env.MODE": '"test"',
				"import.meta.env.DEV": "false",
			},
			conditions: ["workerd", "worker", "browser"],
			external: ["cloudflare:*", "node:*"],
			mainFields: ["module", "main"],
			plugins: [
				{
					name: "ssr-test-stub",
					setup(build) {
						build.onResolve(
							{ filter: /^virtual:react-router\/server-build$/ },
							() => ({ path: "ssr-stub", namespace: "ssr" }),
						);
						build.onLoad({ filter: /.*/, namespace: "ssr" }, () => ({
							contents: "export default {};",
							loader: "js",
						}));
					},
				},
				{
					name: "node-builtins",
					setup(build) {
						build.onResolve({ filter: /^[a-z]/ }, (args) =>
							builtinModules.includes(args.path)
								? { path: `node:${args.path}`, external: true }
								: undefined,
						);
					},
				},
			],
			loader: { ".sql": "text" },
			logLevel: "silent",
		});
		const mf = new Miniflare({
			modules: [
				{
					type: "ESModule",
					path: "worker.mjs",
					contents: compiled.outputFiles[0].text,
				},
			],
			compatibilityDate: "2025-11-28",
			compatibilityFlags: ["nodejs_compat"],
			d1Databases: ["DIRECTORY"],
			r2Buckets: ["BUCKET"],
			durableObjects: {
				MAILBOX: { className: "MailboxDO", useSQLite: true },
				EMAIL_AGENT: { className: "EmailAgent", useSQLite: true },
			},
			bindings: {
				DOMAINS: "ie8.net",
				EMAIL_ADDRESSES: [],
				ADMIN_EMAILS: "admin@example.test",
				BOOTSTRAP_TOKEN: "x".repeat(48),
				DOMAIN_CONFIG_KEY: "runtime-only-domain-key".repeat(3),
			},
		});
		try {
			const fetch = (path: string, init?: RequestInit) =>
				mf.dispatchFetch(`https://inbox.test${path}`, init);
			assert.equal((await fetch("/setup")).status, 200);
			const password = "Strong native password 2026";
			assert.equal((await fetch("/api/v1/me")).status, 401);
			const bootstrap = await fetch("/api/auth/bootstrap", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					email: "admin@example.test",
					password,
					token: "x".repeat(48),
				}),
			});
			assert.equal(bootstrap.status, 200, await bootstrap.clone().text());
			const cookie = bootstrap.headers
				.getSetCookie()
				.find((x) => x.startsWith("__Host-inbox_session="))!
				.split(";")[0];
			assert.equal(
				(await fetch("/api/v1/me", { headers: { Cookie: cookie } })).status,
				200,
			);
			const login = await fetch("/api/auth/login", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email: "admin@example.test", password }),
			});
			assert.equal(login.status, 200, await login.clone().text());
			const nativeCookie = login.headers
				.getSetCookie()
				.find((x) => x.startsWith("__Host-inbox_session="))!
				.split(";")[0];
			const native = (path: string, method = "GET", body?: unknown) =>
				fetch(path, {
					method,
					headers: { Cookie: nativeCookie, "Content-Type": "application/json" },
					...(body ? { body: JSON.stringify(body) } : {}),
				});
			assert.equal((await native("/api/v1/config")).status, 200);
			assert.equal(
				(
					await native("/api/v1/admin/domains/manage", "POST", {
						name: "other.test",
					})
				).status,
				201,
			);
			assert.equal(
				(
					await native("/api/v1/admin/domains/manage/other.test", "PUT", {
						enabled: true,
						receiveEnabled: true,
						sendEnabled: true,
					})
				).status,
				200,
			);
			const created = await native("/api/v1/mailboxes", "POST", {
				name: "Native mailbox",
				prefix: "native",
				domains: ["ie8.net", "other.test"],
				defaultAddress: "native@other.test",
			});
			assert.equal(created.status, 201, await created.clone().text());
			const createdBox = (await created.json()) as any;
			assert.equal(createdBox.addresses.length, 2);
			const draft = await native(
				`/api/v1/mailboxes/${createdBox.id}/drafts`,
				"POST",
				{
					from: "native@other.test",
					to: "outside@example.test",
					subject: "Native draft",
					body: "Hello",
				},
			);
			assert.equal(draft.status, 201, await draft.clone().text());
			const storedDraft = (await (
				await native(
					`/api/v1/mailboxes/${createdBox.id}/emails/${((await draft.json()) as any).id}`,
				)
			).json()) as any;
			assert.equal(storedDraft.sender, "native@other.test");

			const relayCredentials = await native(
				"/api/v1/admin/domains/manage/other.test/relay",
				"POST",
				{ action: "credentials" },
			);
			assert.equal(
				relayCredentials.status,
				200,
				await relayCredentials.clone().text(),
			);
			const relay = (await relayCredentials.json()) as any;
			const probeResponse = await native(
				"/api/v1/admin/domains/manage/other.test/probe",
				"POST",
			);
			const probe = (await probeResponse.json()) as any;
			const raw =
				"From: outside@example.test\r\nSubject: runtime signed probe\r\n\r\nHello";
			const timestamp = String(Math.floor(Date.now() / 1000)),
				requestId = crypto.randomUUID();
			const sig = await signature(
				relay.secret,
				[
					timestamp,
					requestId,
					"outside@example.test",
					probe.address,
					await digest(raw),
				].join("\n"),
			);
			const ingress = await fetch("/ingress/email/other.test", {
				method: "POST",
				headers: {
					"X-Inbox-Time": timestamp,
					"X-Inbox-Id": requestId,
					"X-Inbox-From": "outside@example.test",
					"X-Inbox-To": probe.address,
					"X-Inbox-Signature": sig,
				},
				body: raw,
			});
			assert.equal(ingress.status, 200, await ingress.clone().text());
			assert.ok(
				(
					(await (
						await native("/api/v1/admin/domains/manage/other.test/probe")
					).json()) as any
				).received_at,
			);
			assert.equal(
				(
					await fetch("/ingress/email/other.test", {
						method: "POST",
						body: raw,
					})
				).status,
				401,
			);

			const crossOrigin = await fetch("/api/auth/logout", {
				method: "POST",
				headers: { Cookie: cookie, Origin: "https://other.test" },
			});
			assert.equal(crossOrigin.status, 403);
			assert.equal(
				(
					await fetch("/api/auth/logout", {
						method: "POST",
						headers: { Cookie: cookie },
					})
				).status,
				200,
			);
			assert.equal(
				(await fetch("/api/v1/me", { headers: { Cookie: cookie } })).status,
				401,
			);

			const duplicate = (await (await fetch("/duplicate")).json()) as any;
			assert.deepEqual(duplicate.results, [true, false]);
			assert.equal(duplicate.count, 1);
			const rollback = (await (await fetch("/rollback")).json()) as any;
			assert.equal(rollback.rejected, true);
			assert.equal(rollback.email, null);
			assert.equal((await fetch("/automation-name")).status, 200);
			assert.equal((await fetch("/seed-history")).status, 200);
			const history = await fetch(
				"/agents/email-agent/alice~shared@ie8.net/get-messages",
			);
			assert.equal(history.status, 200, await history.clone().text());
			assert.equal(
				((await history.json()) as any[])[0].parts[0].text,
				"Alice private conversation",
			);
			assert.equal(
				(
					await fetch("/agents/email-agent/alice~shared@ie8.net/get-messages", {
						headers: { "x-test-user": "bob" },
					})
				).status,
				404,
			);
			const socketResponse = await fetch(
				"/agents/email-agent/alice~shared@ie8.net",
				{ headers: { Upgrade: "websocket" } },
			);
			assert.equal(socketResponse.status, 101);
			const socket = socketResponse.webSocket!;
			socket.accept();
			await fetch("/revoke");
			assert.equal(
				(await fetch("/agents/email-agent/alice~shared@ie8.net/get-messages"))
					.status,
				404,
			);
			// A hibernating connection must not process even history/state messages after revocation.
			const result = new Promise<string>((resolve) => {
				socket.addEventListener("close", () => resolve("closed"), {
					once: true,
				});
				socket.addEventListener("error", () => resolve("error"), {
					once: true,
				});
			});
			socket.send(JSON.stringify({ type: "cf_agent_chat_clear" }));
			const reply = await Promise.race([
				result,
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("no-reply"), 5000),
				),
			]);
			assert.equal(reply, "closed");
			await fetch("/restore-access");
			const preserved = (await (
				await fetch("/agents/email-agent/alice~shared@ie8.net/get-messages")
			).json()) as any[];
			assert.equal(preserved[0].parts[0].text, "Alice private conversation");
			socket.close();
		} finally {
			await mf.dispose();
		}
	},
);

test("workerd: provider requests work at the edge and refuse redirects without forwarding credentials", async () => {
	const compiled = await build({
		stdin: {
			contents: `import {provider, seal} from './workers/domain/infrastructure.ts';
				export default {async fetch(request) {
					const env = {DOMAIN_CONFIG_KEY: 'test-only-provider-key'.repeat(3)};
					const c = {id:'test', provider:'cloudflare', credential:await seal(env, 'test-token', 'test')};
					try {return Response.json(await provider(env, c, new URL(request.url).pathname))}
					catch(e) {return Response.json({status:e.status}, {status:502})}
				}};`,
			resolveDir: process.cwd(),
		},
		bundle: true, write: false, format: "esm", platform: "neutral",
		conditions: ["workerd", "worker", "browser"],
		external: ["cloudflare:*", "node:*"],
	});
	const requests: string[] = [];
	const mf = new Miniflare({
		modules: true, script: compiled.outputFiles[0].text,
		outboundService: async (request) => {
			requests.push(request.url);
			assert.equal(request.headers.get("Authorization"), "Bearer test-token");
			if (new URL(request.url).pathname.endsWith("/redirect"))
				return new Response(null, {status:302, headers:{Location:'https://untrusted.test/steal'}});
			return Response.json({success:true, result:{id:'verified-zone'}});
		},
	});
	try {
		const ok = await mf.dispatchFetch("https://local/zones");
		assert.equal(ok.status, 200);
		assert.deepEqual(await ok.json(), {id:'verified-zone'});
		const redirected = await mf.dispatchFetch("https://local/redirect");
		assert.equal(redirected.status, 502);
		assert.deepEqual(await redirected.json(), {status:302});
		assert.deepEqual(requests, ['https://api.cloudflare.com/client/v4/zones', 'https://api.cloudflare.com/client/v4/redirect']);
	} finally { await mf.dispose(); }
});
