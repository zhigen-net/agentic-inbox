import { HTTPException } from "hono/http-exception";
import type { Env } from "../types";
import { directory } from "../lib/auth";
export const enc = new TextEncoder();
export const hex = (v: ArrayBuffer) =>
	Array.from(new Uint8Array(v), (x) => x.toString(16).padStart(2, "0")).join(
		"",
	);
export async function digest(text: string | ArrayBuffer) {
	return hex(
		await crypto.subtle.digest(
			"SHA-256",
			typeof text === "string" ? enc.encode(text) : text,
		),
	);
}
async function key(env: Env) {
	if (!env.DOMAIN_CONFIG_KEY || env.DOMAIN_CONFIG_KEY.length < 32)
		throw new HTTPException(503, {
			message: "域名凭据加密密钥尚未配置，请检查部署 DOMAIN_CONFIG_KEY",
		});
	return crypto.subtle.importKey(
		"raw",
		await crypto.subtle.digest("SHA-256", enc.encode(env.DOMAIN_CONFIG_KEY)),
		"AES-GCM",
		false,
		["encrypt", "decrypt"],
	);
}
export async function seal(env: Env, text: string, context: string) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const data = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: enc.encode(context) },
		await key(env),
		enc.encode(text),
	);
	return hex(iv.buffer) + ":" + hex(data);
}
export async function unseal(env: Env, value: string, context: string) {
	const [iv, data] = value.split(":");
	try {
		const bytes = (s: string) =>
			new Uint8Array(s.match(/../g)!.map((x) => parseInt(x, 16)));
		return new TextDecoder().decode(
			await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: bytes(iv), additionalData: enc.encode(context) },
				await key(env),
				bytes(data),
			),
		);
	} catch {
		throw new HTTPException(503, {
			message: "凭据无法解密，请检查加密密钥或重新保存连接凭据",
		});
	}
}
export interface Connection {
	id: string;
	name: string;
	provider: "cloudflare" | "resend";
	account_id: string | null;
	credential: string;
}
export async function connection(env: Env, id: string | null) {
	return id
		? directory(env)
				.prepare("SELECT * FROM provider_connections WHERE id=?")
				.bind(id)
				.first<Connection>()
		: null;
}
export class ProviderError extends Error {
	constructor(public status: number) {
		super(
			status === 401 || status === 403
				? "服务授权不足或令牌无效"
				: status === 429
					? "服务请求过于频繁"
					: "服务请求失败",
		);
	}
}
export async function provider(
	env: Env,
	c: Connection,
	path: string,
	method = "GET",
	body?: unknown,
): Promise<any> {
	if (!path.startsWith("/") || path.includes(".."))
		throw new Error("Invalid provider path");
	const base =
		c.provider === "cloudflare"
			? "https://api.cloudflare.com/client/v4"
			: "https://api.resend.com";
	const response = await fetch(base + path, {
		method,
		headers: {
			Authorization: `Bearer ${await unseal(env, c.credential, c.id)}`,
			...(body instanceof FormData
				? {}
				: { "Content-Type": "application/json" }),
		},
		body:
			body === undefined
				? undefined
				: body instanceof FormData
					? body
					: JSON.stringify(body),
		redirect: "error",
		signal: AbortSignal.timeout(15000),
	});
	if (!response.ok) throw new ProviderError(response.status);
	const data = (await response.json()) as any;
	if (c.provider === "cloudflare" && !data.success)
		throw new ProviderError(502);
	return c.provider === "cloudflare" ? data.result : data;
}
export async function signature(secret: string, value: string) {
	const k = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return hex(await crypto.subtle.sign("HMAC", k, enc.encode(value)));
}
export async function verifySignature(
	secret: string,
	value: string,
	supplied: string,
) {
	if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
	const k = await crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		"HMAC",
		k,
		new Uint8Array(supplied.match(/../g)!.map((x) => parseInt(x, 16))),
		enc.encode(value),
	);
}
