import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env } from "../types";
import {
	allowedDomains,
	authorizeMailbox,
	currentUser,
	directory,
	requireAdmin,
	type Principal,
} from "../lib/auth";
import { audit } from "./accounts";

export function normalizeDomain(raw: string) {
	const value = raw.trim().toLowerCase().replace(/\.$/, "");
	if (!/^[\p{L}\p{N}.-]+$/u.test(value))
		throw new HTTPException(400, { message: "域名格式错误" });
	let name: string;
	try {
		name = new URL(`https://${value}`).hostname;
	} catch {
		throw new HTTPException(400, { message: "域名格式错误" });
	}
	if (
		/^\d+(\.\d+){3}$/.test(name) ||
		name.length > 253 ||
		!name.includes(".") ||
		!name
			.split(".")
			.every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p))
	)
		throw new HTTPException(400, { message: "域名格式错误" });
	return name;
}
export async function ensureLegacyDirectory(env: Env) {
	const db = directory(env);
	if (
		await db
			.prepare(
				"SELECT value FROM app_settings WHERE key='legacy_import_complete'",
			)
			.first()
	)
		return;
	for (const domain of allowedDomains(env))
		await db
			.prepare(
				"INSERT OR IGNORE INTO domains(name,receive_enabled,send_enabled) VALUES (?,1,1)",
			)
			.bind(domain)
			.run();
	let cursor: string | undefined;
	do {
		const page = await env.BUCKET.list({
			prefix: "mailboxes/",
			limit: 100,
			cursor,
		});
		for (const obj of page.objects) {
			if (!obj.key.endsWith(".json")) continue;
			const address = obj.key.slice(10, -5).toLowerCase();
			if (!z.string().email().safeParse(address).success) continue;
			const domain = address.split("@")[1];
			await db.batch([
				db
					.prepare(
						"INSERT OR IGNORE INTO domains(name,receive_enabled,send_enabled) VALUES (?,1,1)",
					)
					.bind(domain),
				db
					.prepare(
						"INSERT OR IGNORE INTO mailboxes(address,name,stable_id,default_address) VALUES (?,?,?,?)",
					)
					.bind(address, address, crypto.randomUUID(), address),
				db
					.prepare(
						"INSERT OR IGNORE INTO mailbox_addresses(address,mailbox_address,domain) VALUES (?,?,?)",
					)
					.bind(address, address, domain),
			]);
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	await db
		.prepare(
			"INSERT OR IGNORE INTO app_settings(key,value) VALUES ('legacy_import_complete','1')",
		)
		.run();
}
export async function mailboxAddresses(env: Env, mailboxId: string) {
	return (
		await directory(env)
			.prepare(
				`SELECT a.address,a.active,a.receive_enabled,a.send_enabled,d.enabled AS domain_enabled,
 d.receive_enabled AS domain_receive,d.send_enabled AS domain_send FROM mailbox_addresses a JOIN domains d ON d.name=a.domain
 WHERE a.mailbox_address=? ORDER BY a.address`,
			)
			.bind(mailboxId)
			.all()
	).results;
}
export async function defaultAddress(
	env: Env,
	mailboxId: string,
): Promise<string> {
	const row = await directory(env)
		.prepare(
			"SELECT default_address FROM mailboxes WHERE address=? AND active=1",
		)
		.bind(mailboxId)
		.first<{ default_address: string }>();
	return row?.default_address || mailboxId;
}
export async function assertSender(
	env: Env,
	mailboxId: string,
	address: string,
) {
	const allowed = await directory(env)
		.prepare(
			`SELECT a.address FROM mailbox_addresses a JOIN domains d ON d.name=a.domain JOIN mailboxes m ON m.address=a.mailbox_address
 WHERE a.address=? AND a.mailbox_address=? AND a.active=1 AND a.send_enabled=1 AND d.enabled=1 AND d.send_enabled=1 AND m.active=1`,
		)
		.bind(address.toLowerCase(), mailboxId)
		.first();
	if (!allowed)
		throw new HTTPException(403, {
			message: "该发件地址不属于当前邮箱，或尚未启用发信",
		});
}
export async function deliveredMailbox(
	env: Env,
	address: string,
): Promise<string | null> {
	const row = await directory(env)
		.prepare(
			`SELECT m.address FROM mailbox_addresses a JOIN mailboxes m ON m.address=a.mailbox_address JOIN domains d ON d.name=a.domain
 WHERE a.address=? AND a.active=1 AND a.receive_enabled=1 AND m.active=1 AND d.enabled=1 AND d.receive_enabled=1`,
		)
		.bind(address)
		.first<{ address: string }>();
	return row?.address || null;
}
export async function createMailbox(
	env: Env,
	principal: Principal,
	input: unknown,
) {
	await ensureLegacyDirectory(env);
	const body = z
		.object({
			name: z.string().trim().min(1).max(80),
			prefix: z.string().trim().toLowerCase().optional(),
			domains: z.array(z.string()).min(1).max(20).optional(),
			email: z.string().email().optional(),
			defaultAddress: z.string().email().optional(),
			ownerId: z.string().optional(),
			settings: z.record(z.unknown()).optional(),
		})
		.parse(input);
	const user = await currentUser(env, principal);
	const prefix = body.prefix || body.email?.split("@")[0].toLowerCase();
	const domains = [
		...new Set(
			(body.domains || (body.email ? [body.email.split("@")[1]] : [])).map(
				normalizeDomain,
			),
		),
	];
	if (
		!prefix ||
		!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(prefix) ||
		prefix.includes("..") ||
		!domains.length
	)
		throw new HTTPException(400, {
			message: "请输入有效邮箱前缀并至少选择一个域名",
		});
	if (user.role !== "admin") {
		if (!user.can_create_mailboxes)
			throw new HTTPException(403, { message: "未获得自行创建邮箱的权限" });
		if (
			[
				"admin",
				"postmaster",
				"abuse",
				"hostmaster",
				"webmaster",
				"root",
			].includes(prefix)
		)
			throw new HTTPException(403, { message: "该前缀仅限管理员使用" });
		if (body.ownerId && body.ownerId !== user.id)
			throw new HTTPException(403, { message: "不能为其他用户创建邮箱" });
	}
	const db = directory(env);
	for (const domain of domains) {
		if (
			!(await db
				.prepare("SELECT name FROM domains WHERE name=? AND enabled=1")
				.bind(domain)
				.first())
		)
			throw new HTTPException(400, { message: `域名不可用：${domain}` });
		if (
			user.role !== "admin" &&
			!(await db
				.prepare("SELECT domain FROM user_domains WHERE user_id=? AND domain=?")
				.bind(user.id, domain)
				.first())
		)
			throw new HTTPException(403, { message: `没有使用 ${domain} 的权限` });
	}
	const addresses = domains.map((d) => `${prefix}@${d}`);
	if (addresses.some((a) => !z.string().email().safeParse(a).success))
		throw new HTTPException(400, { message: "邮箱地址格式错误" });
	const primary = body.defaultAddress?.toLowerCase() || addresses[0];
	if (!addresses.includes(primary))
		throw new HTTPException(400, { message: "默认地址必须属于已选域名" });
	const ownerId = body.ownerId || user.id;
	if (
		!(await db
			.prepare(
				"SELECT id FROM users WHERE id=? AND active=1 AND status='approved'",
			)
			.bind(ownerId)
			.first())
	)
		throw new HTTPException(400, { message: "指定用户不可用" });
	const storageKey = addresses[0],
		stableId = crypto.randomUUID();
	const statements = [
		db
			.prepare(
				"INSERT INTO mailboxes(address,name,active,stable_id,created_by,owner_id,default_address) VALUES (?,?,1,?,?,?,?)",
			)
			.bind(storageKey, body.name, stableId, user.id, ownerId, primary),
	];
	for (const address of addresses)
		statements.push(
			db
				.prepare(
					"INSERT INTO mailbox_addresses(address,mailbox_address,domain) VALUES (?,?,?)",
				)
				.bind(address, storageKey, address.split("@")[1]),
		);
	statements.push(
		db
			.prepare(
				"INSERT INTO mailbox_members(mailbox_address,user_id,role) VALUES (?,?,'editor')",
			)
			.bind(storageKey, ownerId),
	);
	statements.push(
		db
			.prepare(
				"INSERT INTO operation_log(id,actor_id,action,target,detail) VALUES (?,?,?,?,?)",
			)
			.bind(
				crypto.randomUUID(),
				user.id,
				"mailbox.create",
				storageKey,
				JSON.stringify({ addresses, ownerId }),
			),
	);
	try {
		await db.batch(statements);
	} catch (error) {
		const message = String(error);
		if (message.includes("QUOTA"))
			throw new HTTPException(409, { message: "已达到可创建邮箱数量上限" });
		if (message.includes("CREATION_DENIED"))
			throw new HTTPException(403, { message: "创建权限已被撤销" });
		if (message.includes("UNIQUE"))
			throw new HTTPException(409, {
				message: "所选地址已被占用或停用保留，请调整选择",
			});
		throw error;
	}
	try {
		await env.BUCKET.put(
			`mailboxes/${storageKey}.json`,
			JSON.stringify({
				fromName: body.name,
				autoDraftEnabled: false,
				...body.settings,
			}),
		);
		await env.MAILBOX.get(env.MAILBOX.idFromName(storageKey)).getFolders();
	} catch (error) {
		await db
			.prepare("UPDATE mailboxes SET active=0 WHERE address=?")
			.bind(storageKey)
			.run();
		throw error;
	}
	return {
		id: storageKey,
		stableId,
		email: primary,
		name: body.name,
		role: user.role === "admin" ? "admin" : "editor",
		addresses: await mailboxAddresses(env, storageKey),
	};
}
export async function changeAddresses(
	env: Env,
	principal: Principal,
	mailboxId: string,
	input: unknown,
) {
	await requireAdmin(env, principal);
	await authorizeMailbox(env, principal, mailboxId, "manage");
	const body = z
		.object({
			addDomains: z.array(z.string()).max(20).default([]),
			disable: z.array(z.string().email()).default([]),
			enable: z.array(z.string().email()).default([]),
			defaultAddress: z.string().email().optional(),
			options: z
				.array(
					z.object({
						address: z.string().email(),
						receiveEnabled: z.boolean(),
						sendEnabled: z.boolean(),
					}),
				)
				.max(20)
				.default([]),
		})
		.parse(input);
	const db = directory(env),
		all = await mailboxAddresses(env, mailboxId);
	const prefix = mailboxId.split("@")[0];
	const existingDefault = await defaultAddress(env, mailboxId);
	const selected = body.defaultAddress?.toLowerCase() || existingDefault;
	if (body.disable.includes(selected))
		throw new HTTPException(400, { message: "请先选择另一个默认地址" });
	const adds = [...new Set(body.addDomains.map(normalizeDomain))].map(
		(d) => `${prefix}@${d}`,
	);
	if (
		all.length + adds.filter((a) => !all.some((x) => x.address === a)).length >
		20
	)
		throw new HTTPException(400, { message: "每个邮箱最多关联 20 个地址" });
	const statements: D1PreparedStatement[] = [];
	for (const address of adds) {
		const domain = address.split("@")[1];
		if (
			!(await db
				.prepare("SELECT name FROM domains WHERE name=? AND enabled=1")
				.bind(domain)
				.first())
		)
			throw new HTTPException(400, { message: "域名不可用" });
		statements.push(
			db
				.prepare(
					"INSERT INTO mailbox_addresses(address,mailbox_address,domain) VALUES (?,?,?)",
				)
				.bind(address, mailboxId, domain),
		);
	}
	for (const [list, active] of [
		[body.disable, 0],
		[body.enable, 1],
	] as const)
		for (const address of list) {
			if (!all.some((a) => a.address === address))
				throw new HTTPException(400, { message: "地址不属于此邮箱" });
			statements.push(
				db
					.prepare(
						"UPDATE mailbox_addresses SET active=? WHERE address=? AND mailbox_address=?",
					)
					.bind(active, address, mailboxId),
			);
		}
	if (
		!all.some(
			(a) =>
				a.address === selected && (a.active || body.enable.includes(selected)),
		) &&
		!adds.includes(selected)
	)
		throw new HTTPException(400, { message: "默认地址不可用" });
	for (const option of body.options) {
		if (!all.some((a) => a.address === option.address))
			throw new HTTPException(400, { message: "地址不属于此邮箱" });
		if (option.address === selected && !option.sendEnabled)
			throw new HTTPException(400, {
				message: "请先更换默认发件地址，再关闭原地址发信",
			});
		statements.push(
			db
				.prepare(
					"UPDATE mailbox_addresses SET receive_enabled=?,send_enabled=? WHERE address=? AND mailbox_address=?",
				)
				.bind(
					Number(option.receiveEnabled),
					Number(option.sendEnabled),
					option.address,
					mailboxId,
				),
		);
	}
	if (body.defaultAddress) await assertSender(env, mailboxId, selected); // 新增地址先保存，之后再设为默认发件地址。
	statements.push(
		db
			.prepare("UPDATE mailboxes SET default_address=? WHERE address=?")
			.bind(selected, mailboxId),
	);
	try {
		await db.batch(statements);
	} catch (e) {
		if (String(e).includes("UNIQUE"))
			throw new HTTPException(409, { message: "地址已被占用，未执行任何更改" });
		throw e;
	}
	await audit(env, principal, "mailbox.addresses", mailboxId, body);
	return mailboxAddresses(env, mailboxId);
}
