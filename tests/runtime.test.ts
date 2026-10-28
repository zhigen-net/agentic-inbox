import assert from "node:assert/strict";
import { test } from "node:test";
import { builtinModules } from "node:module";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

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
			conditions: ["workerd", "worker", "browser"],
			external: ["cloudflare:*", "node:*"],
			mainFields: ["module", "main"],
			plugins: [
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
			modules: true,
			script: compiled.outputFiles[0].text,
			compatibilityDate: "2025-11-28",
			compatibilityFlags: ["nodejs_compat"],
			d1Databases: ["DIRECTORY"],
			r2Buckets: ["BUCKET"],
			durableObjects: {
				MAILBOX: { className: "MailboxDO", useSQLite: true },
				EMAIL_AGENT: { className: "EmailAgent", useSQLite: true },
			},
			bindings: { DOMAINS: "ie8.net", EMAIL_ADDRESSES: [], ADMIN_EMAILS: "" },
		});
		try {
			const fetch = (path: string, init?: RequestInit) =>
				mf.dispatchFetch(`https://inbox.test${path}`, init);
			assert.equal((await fetch("/setup")).status, 200);
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
				socket.addEventListener("message", (e) => resolve(String(e.data)), {
					once: true,
				});
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
					setTimeout(() => resolve("no-reply"), 1000),
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
