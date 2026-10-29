import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { MailboxContext } from "../lib/mailbox";
import { directory } from "../lib/auth";
import { domainRow } from "../domain/domain-health";
import { normalizeDomain } from "../domain/mailboxes";
import { unseal, digest, verifySignature } from "../domain/infrastructure";
import { receiveEmail } from "../index";
export const ingressApp = new Hono<MailboxContext>();
ingressApp.use(
	"/ingress/*",
	bodyLimit({
		maxSize: 25 * 1024 * 1024,
		onError: (c) => c.json({ error: "Message too large" }, 413),
	}),
);
ingressApp.post("/ingress/email/:domain", async (c) => {
	const name = normalizeDomain(c.req.param("domain"));
	const time = c.req.header("X-Inbox-Time") || "",
		requestId = c.req.header("X-Inbox-Id") || "",
		from = c.req.header("X-Inbox-From") || "",
		to = c.req.header("X-Inbox-To") || "",
		sig = c.req.header("X-Inbox-Signature") || "";
	if (
		!/^\d{10}$/.test(time) ||
		Math.abs(Date.now() / 1000 - Number(time)) > 300 ||
		!z.string().uuid().safeParse(requestId).success ||
		!(from === "" || z.string().email().max(254).safeParse(from).success) ||
		!z.string().email().max(254).safeParse(to).success ||
		to.toLowerCase().split("@")[1] !== name ||
		!/^[a-f0-9]{64}$/.test(sig)
	)
		return c.json({ error: "Invalid relay request" }, 401);
	const row = await domainRow(c.env, name);
	if (!row.relay_key) return c.json({ error: "Relay not configured" }, 403);
	const raw = await c.req.arrayBuffer();
	if (!raw.byteLength) return c.json({ error: "Empty message" }, 400);
	const valid = await verifySignature(
		await unseal(c.env, row.relay_key, "relay:" + name),
		[time, requestId, from, to, await digest(raw)].join("\n"),
		sig,
	);
	if (!valid) return c.json({ error: "Invalid relay signature" }, 401);
	const db = directory(c.env),
		receipt = await db
			.prepare("SELECT domain FROM relay_receipts WHERE id=?")
			.bind(requestId)
			.first<{ domain: string }>();
	if (receipt)
		return receipt.domain === name
			? c.json({ ok: true, duplicate: true })
			: c.json({ error: "Request ID conflict" }, 409);
	let rejected = false;
	// The existing receiver applies the same alias mapping, disabled-address checks and raw-message deduplication.
	await receiveEmail(
		{
			from,
			to,
			raw: new Blob([raw]).stream(),
			rawSize: raw.byteLength,
			headers: new Headers(),
			setReject() {
				rejected = true;
			},
		} as unknown as ForwardableEmailMessage,
		c.env,
		c.executionCtx as unknown as ExecutionContext,
		async (data) => {
			const { getAgentByName } = await import("agents");
			const agent = await getAgentByName(c.env.EMAIL_AGENT, data.mailboxId);
			return agent.handleNewEmail(data);
		},
	);
	if (rejected) return c.json({ error: "Unknown or disabled recipient" }, 422);
	await db.batch([
		db
			.prepare("DELETE FROM relay_receipts WHERE created_at<?")
			.bind(Math.floor(Date.now() / 1000) - 86400),
		db
			.prepare(
				"INSERT OR IGNORE INTO relay_receipts(id,domain,created_at) VALUES (?,?,?)",
			)
			.bind(requestId, name, Math.floor(Date.now() / 1000)),
	]);
	return c.json({ ok: true });
});
