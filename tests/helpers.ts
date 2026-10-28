import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import type { Env } from "../workers/types";

// Execute the production SQL against SQLite; only Cloudflare's result envelope is adapted.
export function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = ON");
	sqlite.exec(
		readFileSync(
			new URL("../migrations/0001_team_directory.sql", import.meta.url),
			"utf8",
		),
	);
	sqlite.exec(
		readFileSync(
			new URL("../migrations/0002_accounts_addresses.sql", import.meta.url),
			"utf8",
		),
	);

	function prepare(sql: string) {
		let values: any[] = [];
		const statement = {
			bind(...args: any[]) {
				values = args;
				return statement;
			},
			async first(column?: string) {
				const row = sqlite.prepare(sql).get(...values);
				return row ? (column ? row[column] : row) : null;
			},
			async all() {
				return { success: true, results: sqlite.prepare(sql).all(...values) };
			},
			async run() {
				const result = sqlite.prepare(sql).run(...values);
				return { success: true, meta: { changes: Number(result.changes) } };
			},
		};
		return statement;
	}
	const directory = {
		prepare,
		async batch(statements: ReturnType<typeof prepare>[]) {
			sqlite.exec("BEGIN");
			try {
				const results = [];
				for (const s of statements) results.push(await s.run());
				sqlite.exec("COMMIT");
				return results;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
	const objects = new Map<string, string>();
	const bucket = {
		async head(key: string) {
			return objects.has(key) ? { key } : null;
		},
		async get(key: string) {
			const value = objects.get(key);
			return value === undefined
				? null
				: { json: async () => JSON.parse(value), body: value };
		},
		async put(key: string, value: any) {
			objects.set(key, typeof value === "string" ? value : "attachment");
		},
		async delete(keys: string | string[]) {
			for (const key of Array.isArray(keys) ? keys : [keys])
				objects.delete(key);
		},
		async list({
			prefix,
			limit = 1000,
			cursor,
		}: {
			prefix: string;
			limit?: number;
			cursor?: string;
		}) {
			const keys = [...objects.keys()]
				.filter((key) => key.startsWith(prefix))
				.sort();
			const offset = Number(cursor || 0);
			return {
				objects: keys.slice(offset, offset + limit).map((key) => ({ key })),
				truncated: keys.length > offset + limit,
				cursor: String(offset + limit),
			};
		},
	};
	const calls: { mailbox: string; method: string }[] = [];
	const mail = new Map<string, Map<string, any>>();
	const attachments = new Map<string, any>();
	const automation: any[] = [];
	const stubs = new Map<string, any>();
	function stub(address: string) {
		if (stubs.has(address)) return stubs.get(address);
		const emails = new Map<string, any>();
		mail.set(address, emails);
		const result = {
			async findThreadBySubject() {
				return null;
			},
			async getFolders() {
				calls.push({ mailbox: address, method: "getFolders" });
				return [];
			},
			async getEmails() {
				calls.push({ mailbox: address, method: "getEmails" });
				return [...emails.values()];
			},
			async countEmails() {
				return emails.size;
			},
			async getEmail(id: string) {
				calls.push({ mailbox: address, method: "getEmail" });
				return emails.get(id) || null;
			},
			async createEmail(folder: string, email: any, atts: any[]) {
				if (emails.has(email.id)) return false;
				emails.set(email.id, {
					...email,
					folder_id: folder,
					attachments: atts,
				});
				return true;
			},
			async getAttachment(id: string) {
				return attachments.get(`${address}:${id}`) || null;
			},
			async updateEmail(id: string, values: any) {
				const email = emails.get(id);
				Object.assign(email, values);
				return email;
			},
		};
		stubs.set(address, result);
		return result;
	}
	const env = {
		DIRECTORY: directory,
		BUCKET: bucket,
		DOMAINS: "ie8.net,other.test",
		EMAIL_ADDRESSES: [],
		ADMIN_EMAILS: "admin@example.test",
		MAILBOX: { idFromName: (name: string) => name, get: stub },
		EMAIL_AGENT: {
			idFromName: (name: string) => name,
			get: (address: string) => ({
				handleNewEmail: async (data: any) => {
					automation.push({ address, data });
				},
			}),
		},
	} as unknown as Env;
	function user(id: string, email = `${id}@example.test`, role = "member") {
		sqlite
			.prepare("INSERT INTO users (id, email, role) VALUES (?, ?, ?)")
			.run(id, email, role);
		return { userId: id, email };
	}
	function mailbox(address: string, members: Record<string, string> = {}) {
		sqlite
			.prepare("INSERT INTO mailboxes (address, name) VALUES (?, ?)")
			.run(address, address);
		objects.set(`mailboxes/${address}.json`, "{}");
		sqlite
			.prepare(
				"INSERT OR IGNORE INTO domains(name,receive_enabled,send_enabled) VALUES (?,1,1)",
			)
			.run(address.split("@")[1]);
		sqlite
			.prepare(
				"INSERT OR IGNORE INTO mailbox_addresses(address,mailbox_address,domain) VALUES (?,?,?)",
			)
			.run(address, address, address.split("@")[1]);
		sqlite
			.prepare(
				"UPDATE mailboxes SET default_address=?,stable_id=? WHERE address=?",
			)
			.run(address, crypto.randomUUID(), address);
		for (const [id, role] of Object.entries(members))
			sqlite
				.prepare(
					"INSERT INTO mailbox_members (mailbox_address, user_id, role) VALUES (?, ?, ?)",
				)
				.run(address, id, role);
		stub(address);
	}
	return {
		env,
		sqlite,
		user,
		mailbox,
		objects,
		calls,
		mail,
		attachments,
		automation,
		stub,
	};
}
