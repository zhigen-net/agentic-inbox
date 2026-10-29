// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { getAgentByName, routeAgentRequest } from "agents";
import { Hono } from "hono";
import { jwtVerify, createRemoteJWKSet } from "jose";
import { createRequestHandler } from "react-router";
import { app as apiApp, receiveEmail } from "./index";
import { handleMCP } from "./mcp";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import {
	authorizeAgentPath,
	resolvePrincipal,
	type AuthVariables,
} from "./lib/auth";
import { getCookie } from "hono/cookie";
import { ingressApp } from "./routes/ingress";
import { accountsApp } from "./routes/accounts";
import { SESSION_COOKIE, sessionPrincipal } from "./domain/accounts";
import type { Env } from "./types";

export { MailboxDO } from "./durableObject";
export { EmailAgent } from "./agent";
export { EmailMCP } from "./mcp/legacy";

declare module "react-router" {
	export interface AppLoadContext {
		cloudflare: {
			env: Env;
			ctx: ExecutionContext;
		};
	}
}

const requestHandler = createRequestHandler(
	() => import("virtual:react-router/server-build"),
	import.meta.env.MODE,
);

function getAccessUrls(teamDomain: string) {
	const certsPath = "/cdn-cgi/access/certs";
	const teamUrl = new URL(teamDomain);
	const issuer = teamUrl.origin;
	const certsUrl = teamUrl.pathname.endsWith(certsPath)
		? teamUrl
		: new URL(certsPath, issuer);

	return { issuer, certsUrl };
}

// Reuse the remote key set within a Worker isolate instead of refetching it on each request.
const accessKeySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// Main app that wraps the API and adds React Router fallback
const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.onError((error, c) => {
	if (error instanceof HTTPException)
		return c.json({ error: error.message }, error.status);
	if (error instanceof ZodError)
		return c.json({ error: "Invalid request", issues: error.issues }, 400);
	console.error("Request failed:", error.message);
	return c.json({ error: "Internal server error" }, 500);
});

app.route("/", ingressApp);

// Require same-origin browser writes, including Agent WebSocket handshakes.
app.use("*", async (c, next) => {
	const origin = c.req.header("Origin");
	if (origin && origin !== new URL(c.req.url).origin)
		return c.json({ error: "Cross-origin requests are not allowed" }, 403);
	await next();
});

// 原生会话优先；保留经过验证的 Access 登录桥接，避免旧管理员升级后被锁在门外。
app.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	c.header("Referrer-Policy", "no-referrer");
	let principal = await sessionPrincipal(c.env, getCookie(c, SESSION_COOKIE));
	const token = c.req.header("cf-access-jwt-assertion");
	if (
		!principal &&
		!getCookie(c, "inbox_signed_out") &&
		token &&
		c.env.POLICY_AUD &&
		c.env.TEAM_DOMAIN
	) {
		try {
			const { issuer, certsUrl } = getAccessUrls(c.env.TEAM_DOMAIN);
			const key = certsUrl.toString();
			let keys = accessKeySets.get(key);
			if (!keys) {
				keys = createRemoteJWKSet(certsUrl);
				accessKeySets.set(key, keys);
			}
			const { payload } = await jwtVerify(token, keys, {
				issuer,
				audience: c.env.POLICY_AUD,
			});
			principal = await resolvePrincipal(c.env, payload);
		} catch {
			/* 原生登录不依赖 Access；不接受未经验证的邮件头。 */
		}
	}
	if (principal) c.set("principal", principal);
	const path = new URL(c.req.url).pathname;
	if (
		!principal &&
		(path.startsWith("/api/v1/") ||
			path.startsWith("/agents/") ||
			path.startsWith("/mcp"))
	)
		return c.json({ error: "请先登录" }, 401);
	return next();
});
app.route("/", accountsApp);

// MCP server endpoint — used by AI coding tools (ProtoAgent, Claude Code, Cursor, etc.)
// Must be before API routes and React Router catch-all
app.all("/mcp", (c) => handleMCP(c.req.raw, c.env, c.var.principal));
app.all("/mcp/*", (c) =>
	c.json({ error: "Use the Streamable HTTP MCP endpoint at /mcp" }, 404),
);

// Mount the API routes
app.route("/", apiApp);

// Agent WebSocket routing - must be before React Router catch-all
app.all("/agents/*", async (c) => {
	await authorizeAgentPath(c.env, c.var.principal, new URL(c.req.url).pathname);
	const response = await routeAgentRequest(c.req.raw, c.env);
	if (response) return response;
	return c.text("Agent not found", 404);
});

// React Router catch-all: serves the SPA for all non-API routes
app.all("*", (c) => {
	return requestHandler(c.req.raw, {
		cloudflare: { env: c.env, ctx: c.executionCtx as ExecutionContext },
	});
});

// Export the Hono app as the default export with an email handler
export default {
	fetch: app.fetch,
	async email(event: ForwardableEmailMessage, env: Env, ctx: ExecutionContext) {
		try {
			await receiveEmail(event, env, ctx, async (data) => {
				const agent = await getAgentByName(env.EMAIL_AGENT, data.mailboxId);
				return agent.handleNewEmail(data);
			});
		} catch (e) {
			console.error(
				"Failed to process incoming email:",
				(e as Error).message,
				(e as Error).stack,
			);
			// Re-throw so Cloudflare's email routing can retry delivery or bounce the message.
			// Swallowing the error would silently drop the email.
			throw e;
		}
	},
};
