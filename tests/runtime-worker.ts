// This fixture is bundled only by runtime.test.ts and is never included in production.
import production from "../workers/app";
import { routeAgentRequest, getAgentByName } from "agents";
import { HTTPException } from "hono/http-exception";
import { authorizeAgentPath } from "../workers/lib/auth";
import { MailboxDO } from "../workers/durableObject";
import { EmailAgent } from "../workers/agent";
import migration2 from "../migrations/0002_accounts_addresses.sql";
import migration from "../migrations/0001_team_directory.sql";
import type { Env } from "../workers/types";
export { MailboxDO, EmailAgent };
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const path = new URL(request.url).pathname;
		try {
			if (path === "/setup") {
				const statements = migration
					.replace(/--[^\n]*/g, "")
					.split(";")
					.map((x) => x.trim())
					.filter(Boolean);
				for (const sql of statements) await env.DIRECTORY.prepare(sql).run();
				const cleaned = migration2.replace(/--[^\n]*/g, "");
				const [regular, trigger] = cleaned.split("CREATE TRIGGER");
				for (const sql of regular
					.split(";")
					.map((s) => s.trim())
					.filter(Boolean))
					await env.DIRECTORY.prepare(sql).run();
				await env.DIRECTORY.prepare("CREATE TRIGGER" + trigger).run();
				await env.DIRECTORY.prepare(
					"INSERT INTO users (id,email) VALUES ('alice','alice@example.test'), ('bob','bob@example.test')",
				).run();
				await env.DIRECTORY.prepare(
					"INSERT INTO mailboxes (address,name) VALUES ('shared@ie8.net','Shared')",
				).run();
				await env.DIRECTORY.prepare(
					"INSERT INTO mailbox_members (mailbox_address,user_id,role) VALUES ('shared@ie8.net','alice','editor'), ('shared@ie8.net','bob','viewer')",
				).run();
				return Response.json({ ok: true });
			}
			if (path === "/seed-history") {
				const agent = await getAgentByName(
					env.EMAIL_AGENT,
					"alice~shared@ie8.net",
				);
				await agent.persistMessages([
					{
						id: "private-message",
						role: "user",
						parts: [{ type: "text", text: "Alice private conversation" }],
					},
				]);
				return Response.json({ ok: true });
			}
			if (path === "/restore-access") {
				await env.DIRECTORY.prepare(
					"INSERT INTO mailbox_members (mailbox_address,user_id,role) VALUES ('shared@ie8.net','alice','editor')",
				).run();
				return Response.json({ ok: true });
			}
			if (path === "/revoke") {
				await env.DIRECTORY.prepare(
					"DELETE FROM mailbox_members WHERE user_id = 'alice'",
				).run();
				return Response.json({ ok: true });
			}
			if (path === "/duplicate") {
				const stub = env.MAILBOX.get(env.MAILBOX.idFromName("shared@ie8.net"));
				const email = {
					id: "stable-id",
					subject: "test",
					sender: "external@example.test",
					recipient: "shared@ie8.net",
					date: new Date().toISOString(),
					body: "test",
				};
				const results = await Promise.all([
					stub.createEmail("inbox", email, []),
					stub.createEmail("inbox", email, []),
				]);
				return Response.json({
					results,
					count: await stub.countEmails({ folder: "inbox" }),
				});
			}
			if (path === "/rollback") {
				const stub = env.MAILBOX.get(env.MAILBOX.idFromName("shared@ie8.net"));
				const email = {
					id: "rollback-id",
					subject: "test",
					sender: "external@example.test",
					recipient: "shared@ie8.net",
					date: new Date().toISOString(),
					body: "test",
				};
				let rejected = false;
				try {
					await stub.createEmail("inbox", email, [
						{
							id: "invalid",
							email_id: "missing-parent",
							filename: "a",
							mimetype: "text/plain",
							size: 1,
							content_id: null,
							disposition: "attachment",
						},
					]);
				} catch {
					rejected = true;
				}
				return Response.json({
					rejected,
					email: await stub.getEmail(email.id),
				});
			}
			if (path === "/automation-name") {
				const agent = await getAgentByName(env.EMAIL_AGENT, "shared@ie8.net");
				// set-name initialization must remain reachable to trusted internal callers.
				return Response.json({ initialized: !!agent });
			}
			if (path.startsWith("/api/")) return production.fetch(request, env, ctx);
			const principal = {
				userId: request.headers.get("x-test-user") || "alice",
				email: "",
			};
			await authorizeAgentPath(env, principal, path);
			return (
				(await routeAgentRequest(request, env)) ||
				new Response("Not found", { status: 404 })
			);
		} catch (error) {
			return new Response(error instanceof Error ? error.message : "Failed", {
				status: error instanceof HTTPException ? error.status : 500,
			});
		}
	},
};
