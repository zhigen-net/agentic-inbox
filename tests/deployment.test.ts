import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { test } from "node:test";
import { parse } from "jsonc-parser";
import { deploy, makeConfig, workerName } from "../scripts/cf-deploy.mjs";

const source = parse(
	await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
);
const env = {
	APP_NAME: "inbox-dev",
	CLOUDFLARE_ACCOUNT_ID: "test-account",
	CLOUDFLARE_API_TOKEN: "test-token",
};
const secrets = ["POLICY_AUD", "TEAM_DOMAIN", "ADMIN_EMAILS"].map((name) => ({
	name,
	type: "secret_text",
}));
function fakeAPI({
	existing = true,
	databases = [] as any[],
	bucket = true,
	bindings = [] as any[],
} = {}) {
	const calls: { endpoint: string; method: string }[] = [];
	const api = async (endpoint: string, options: any = {}) => {
		calls.push({ endpoint, method: options.method || "GET" });
		if (endpoint.endsWith("/settings"))
			return existing ? { result: { bindings } } : null;
		if (endpoint.startsWith("d1/database?"))
			return { result: databases, result_info: { total_pages: 1 } };
		if (endpoint.startsWith("r2/buckets/"))
			return bucket ? { result: { name: "existing" } } : null;
		if (endpoint === "d1/database" && options.method === "POST")
			return { result: { uuid: "new-db-id" } };
		if (endpoint === "r2/buckets" && options.method === "POST")
			return { result: {} };
		throw new Error(`Unexpected endpoint: ${endpoint}`);
	};
	return { api, calls };
}

test("deployment name uses Workers Builds override and requires an explicit local name", () => {
	assert.equal(
		workerName({ ...env, WRANGLER_CI_OVERRIDE_NAME: "inbox-production" }),
		"inbox-production",
	);
	assert.throws(() => workerName({}));
	assert.throws(() => workerName({ APP_NAME: "../other" }));
});
test("deployment preserves existing bucket, D1, variables and secrets; new environments receive isolated resources", () => {
	const settings = {
		bindings: [
			{ name: "BUCKET", type: "r2_bucket", bucket_name: "legacy-mail-bucket" },
			{ name: "DIRECTORY", type: "d1", id: "existing-id" },
			{ name: "DOMAINS", type: "plain_text", text: "existing.test" },
			{ name: "EMAIL_ADDRESSES", type: "json", json: ["team@existing.test"] },
			...secrets,
		],
	};
	const existing = makeConfig(
		source,
		settings,
		[{ uuid: "existing-id", name: "legacy-directory" }],
		{ ...env, ADMIN_EMAILS: "do-not-overwrite@example.test" },
	);
	assert.equal(existing.config.r2_buckets[0].bucket_name, "legacy-mail-bucket");
	assert.equal(existing.config.d1_databases[0].database_id, "existing-id");
	assert.equal(existing.config.vars.DOMAINS, "existing.test");
	assert.deepEqual(existing.config.vars.EMAIL_ADDRESSES, [
		"team@existing.test",
	]);
	assert.deepEqual(existing.secrets, {});
	assert.deepEqual(existing.missingSecrets, []);
	const fresh = makeConfig(source, null, [], env);
	assert.equal(fresh.config.r2_buckets[0].bucket_name, "inbox-dev-store");
	assert.equal(
		fresh.config.d1_databases[0].database_name,
		"inbox-dev-directory",
	);
	assert.deepEqual(fresh.missingSecrets.sort(), [
		"ADMIN_EMAILS",
		"POLICY_AUD",
		"TEAM_DOMAIN",
	]);
	assert.throws(() => makeConfig(source, settings, [], env), /停止部署/);
});
test("read-only deployment plan never creates resources, writes configuration or invokes build/deploy", async () => {
	const f = fakeAPI({ existing: false, bucket: false });
	let commands = 0;
	const plan = await deploy({
		env,
		source,
		api: f.api,
		planOnly: true,
		run: async () => {
			commands++;
		},
	});
	assert.equal(plan.createDatabase, true);
	assert.equal(plan.createBucket, true);
	assert.equal(commands, 0);
	assert.ok(f.calls.every((call) => call.method === "GET"));
});
test("automatic deployment creates missing resources, builds before migration, deploys after migration and cleans secret files", async () => {
	const f = fakeAPI({ existing: false, bucket: false });
	const commands: string[][] = [];
	const withSecrets = {
		...env,
		POLICY_AUD: "audience",
		TEAM_DOMAIN: "https://team.example.test",
		ADMIN_EMAILS: "admin@example.test",
	};
	await deploy({
		env: withSecrets,
		source,
		api: f.api,
		run: async (_file: string, args: string[], commandEnv: any) => {
			commands.push(args);
			const generated = JSON.parse(
				await readFile(commandEnv.INBOX_DEPLOY_CONFIG, "utf8"),
			);
			assert.equal(generated.d1_databases[0].database_id, "new-db-id");
			if (args[0] === "wrangler" && args[1] === "deploy") {
				assert.ok(args.includes("--keep-vars"));
				const secretFile = args[args.indexOf("--secrets-file") + 1];
				assert.deepEqual(JSON.parse(await readFile(secretFile, "utf8")), {
					POLICY_AUD: "audience",
					TEAM_DOMAIN: "https://team.example.test",
					ADMIN_EMAILS: "admin@example.test",
				});
				assert.ok(!JSON.stringify(generated).includes("admin@example.test"));
			}
		},
	});
	assert.deepEqual(
		commands.map((args) => args.slice(0, 2)),
		[
			["run", "build"],
			["wrangler", "d1"],
			["wrangler", "deploy"],
		],
	);
	assert.equal(f.calls.filter((call) => call.method === "POST").length, 2);
	await assert.rejects(
		access(new URL("../wrangler.deploy.json", import.meta.url)),
	);
	await assert.rejects(
		access(new URL("../.deploy-secrets.json", import.meta.url)),
	);
});
test("missing secrets, API permission failures and migration failures cannot publish a worker", async () => {
	const f = fakeAPI();
	let commands = 0;
	await assert.rejects(
		deploy({
			env,
			source,
			api: f.api,
			run: async () => {
				commands++;
			},
		}),
		/缺少/,
	);
	assert.equal(commands, 0);
	assert.ok(f.calls.every((call) => call.method === "GET"));
	await assert.rejects(
		deploy({
			env,
			source,
			api: async () => {
				throw new Error("permission denied");
			},
			run: async () => {
				commands++;
			},
		}),
		/permission denied/,
	);
	assert.equal(commands, 0);
	const ready = fakeAPI({
		databases: [{ uuid: "ready", name: "inbox-dev-directory" }],
		bindings: secrets,
	});
	await assert.rejects(
		deploy({
			env,
			source,
			api: ready.api,
			run: async (_file: string, args: string[]) => {
				if (args[1] === "d1") throw new Error("migration failed");
				assert.notEqual(args[1], "deploy");
			},
		}),
		/migration failed/,
	);
	await assert.rejects(
		access(new URL("../wrangler.deploy.json", import.meta.url)),
	);
});
