import { readFile, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parse } from "jsonc-parser";
import { fetch, EnvHttpProxyAgent } from "undici";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SECRET_NAMES = [
	"ADMIN_EMAILS",
	"POLICY_AUD",
	"TEAM_DOMAIN",
	"BOOTSTRAP_TOKEN",
	"DOMAIN_CONFIG_KEY",
];
const REQUIRED_SECRETS = ["ADMIN_EMAILS"];

export function workerName(env) {
	const name = env.WRANGLER_CI_OVERRIDE_NAME || env.APP_NAME;
	if (!name || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name))
		throw new Error(
			"缺少有效 Worker 名：Workers Builds 自动提供 WRANGLER_CI_OVERRIDE_NAME；本地请设置 APP_NAME。",
		);
	return name;
}

export function makeConfig(source, settings, databases, env) {
	const name = workerName(env);
	const bindings = settings?.bindings || [];
	const bucket = bindings.find((b) => b.name === "BUCKET");
	const directory = bindings.find((b) => b.name === "DIRECTORY");
	if (bucket && bucket.type !== "r2_bucket")
		throw new Error("现有 BUCKET 不是 R2 绑定，停止部署。");
	if (directory && directory.type !== "d1")
		throw new Error("现有 DIRECTORY 不是 D1 绑定，停止部署。");
	const databaseId = directory?.id || directory?.database_id;
	const dbName = `${name}-directory`;
	const database = databaseId
		? databases.find((d) => d.uuid === databaseId)
		: databases.find((d) => d.name === dbName);
	if (databaseId && !database)
		throw new Error("现有 DIRECTORY 数据库未在目标账户中找到，停止部署。");
	const config = structuredClone(source);
	config.name = name;
	const liveVars = Object.fromEntries(
		bindings
			.filter((b) => b.type === "plain_text" || b.type === "json")
			.map((b) => [b.name, b.type === "json" ? b.json : b.text]),
	);
	config.vars = { ...config.vars, ...liveVars };
	config.vars.INBOX_ACCOUNT_ID = env.CLOUDFLARE_ACCOUNT_ID;
	config.vars.INBOX_WORKER_NAME = name;
	if (env.INBOX_DOMAINS) config.vars.DOMAINS = env.INBOX_DOMAINS;
	if (!config.vars.DOMAINS?.split(",").some((d) => d.trim()))
		throw new Error(
			"请配置 INBOX_DOMAINS 构建变量或现有 DOMAINS Worker 变量。",
		);
	config.r2_buckets = [
		{
			binding: "BUCKET",
			bucket_name: bucket?.bucket_name || `${name}-store`,
			...(bucket?.jurisdiction ? { jurisdiction: bucket.jurisdiction } : {}),
		},
	];
	config.d1_databases = [
		{
			binding: "DIRECTORY",
			database_name: database?.name || dbName,
			database_id: database?.uuid || "00000000-0000-0000-0000-000000000000",
			migrations_dir: "migrations",
		},
	];
	for (const binding of config.durable_objects.bindings) {
		const live = bindings.find((b) => b.name === binding.name);
		if (
			live &&
			(live.type !== "durable_object_namespace" ||
				live.class_name !== binding.class_name ||
				(live.script_name && live.script_name !== name))
		)
			throw new Error(
				`现有 ${binding.name} 与本应用的 DO 类型不匹配，停止部署。`,
			);
	}
	// Secret 只从部署配置删除，始终保留线上 Secret；缺失项由 --secrets-file 原子注入。
	const existingSecrets = new Set(
		bindings
			.filter(
				(b) => b.type === "secret_text" || (b.type === "plain_text" && b.text),
			)
			.map((b) => b.name),
	);
	const secrets = Object.fromEntries(
		SECRET_NAMES.filter((key) => !existingSecrets.has(key) && env[key]).map(
			(key) => [key, env[key]],
		),
	);
	for (const key of SECRET_NAMES) delete config.vars[key];
	const missingSecrets = REQUIRED_SECRETS.filter(
		(key) => !existingSecrets.has(key) && !secrets[key],
	);
	return {
		config,
		secrets,
		missingSecrets,
		createDatabase: !database,
		initializeDomainKey:
			!existingSecrets.has("DOMAIN_CONFIG_KEY") && !secrets.DOMAIN_CONFIG_KEY,
	};
}

export function cloudflareClient(env, fetchImpl = fetch) {
	if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN)
		throw new Error(
			"构建环境必须提供 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN；请选择目标账户的部署 Token。",
		);
	const dispatcher =
		fetchImpl === fetch &&
		(env.HTTPS_PROXY || env.HTTP_PROXY || env.https_proxy || env.http_proxy)
			? new EnvHttpProxyAgent()
			: undefined;
	const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
	return async (
		endpoint,
		{ method = "GET", body, allowMissing = false } = {},
	) => {
		const response = await fetchImpl(`${base}/${endpoint}`, {
			method,
			headers: {
				Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
				"Content-Type": "application/json",
			},
			...(body ? { body: JSON.stringify(body) } : {}),
			...(dispatcher ? { dispatcher } : {}),
		});
		if (response.status === 404 && allowMissing) return null;
		const data = await response.json();
		// 不输出整个 API 响应或环境，避免泄露变量和凭据。
		if (!response.ok || !data.success)
			throw new Error(
				`Cloudflare ${method} ${endpoint.split("?")[0]} 失败（HTTP ${response.status}，代码 ${(data.errors || []).map((e) => e.code).join(",")}）。请检查目标账户和 Token 权限。`,
			);
		return data;
	};
}

export async function inspectDeployment(env, api, source) {
	const name = workerName(env);
	const settings = await api(`workers/scripts/${name}/settings`, {
		allowMissing: true,
	});
	const databases = [];
	let page = 1;
	while (true) {
		const response = await api(`d1/database?per_page=100&page=${page}`);
		databases.push(...response.result);
		if (page >= (response.result_info?.total_pages ?? 1)) break;
		page++;
	}
	const plan = makeConfig(source, settings?.result, databases, env);
	const bucket = await api(
		`r2/buckets/${plan.config.r2_buckets[0].bucket_name}`,
		{ allowMissing: true },
	);
	return { ...plan, createBucket: !bucket, existingWorker: !!settings };
}

export function command(file, args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(file, args, { cwd: ROOT, env, stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) =>
			code === 0
				? resolve()
				: reject(new Error(`${file} ${args[0]} 执行失败，退出码 ${code}`)),
		);
	});
}

export async function deploy({
	env = process.env,
	planOnly = false,
	api = cloudflareClient(env),
	run = command,
	source,
} = {}) {
	source ||= parse(await readFile(path.join(ROOT, "wrangler.jsonc"), "utf8"));
	const plan = await inspectDeployment(env, api, source);
	const { config, secrets, missingSecrets } = plan;
	const summary = {
		worker: config.name,
		account: env.CLOUDFLARE_ACCOUNT_ID,
		database: config.d1_databases[0].database_name,
		bucket: config.r2_buckets[0].bucket_name,
		existingWorker: plan.existingWorker,
		createDatabase: plan.createDatabase,
		createBucket: plan.createBucket,
		missingSecrets,
		secretsToInitialize: Object.keys(secrets),
	};
	console.log(JSON.stringify(summary, null, 2));
	if (planOnly) return summary; // 只读：不写配置、不创建资源、不迁移、不发布。
	if (missingSecrets.length)
		throw new Error(
			`缺少 ${missingSecrets.join(", ")}。请在 Worker Secrets 或 Workers Builds 构建 Secrets 中配置后重试。`,
		);
	const generated = path.join(ROOT, "wrangler.deploy.json");
	const secretFile = path.join(ROOT, ".deploy-secrets.json");
	if (plan.initializeDomainKey)
		secrets.DOMAIN_CONFIG_KEY = randomBytes(32).toString("hex");
	const buildEnv = { ...env, INBOX_DEPLOY_CONFIG: generated };
	try {
		await rm(generated, { force: true });
		await rm(secretFile, { force: true });
		if (plan.createDatabase) {
			const db = await api("d1/database", {
				method: "POST",
				body: { name: config.d1_databases[0].database_name },
			});
			if (!db.result?.uuid)
				throw new Error("创建 D1 后未返回数据库 ID，停止部署。");
			config.d1_databases[0].database_id = db.result.uuid;
		}
		if (plan.createBucket)
			await api("r2/buckets", {
				method: "POST",
				body: { name: config.r2_buckets[0].bucket_name },
			});
		await writeFile(generated, JSON.stringify(config, null, 2) + "\n", {
			mode: 0o600,
		});
		await run("npm", ["run", "build"], buildEnv);
		// 配置中保留源码路径，迁移不依赖构建输出目录的相对位置。
		await run(
			"npx",
			[
				"wrangler",
				"d1",
				"migrations",
				"apply",
				"DIRECTORY",
				"--remote",
				"--config",
				generated,
			],
			buildEnv,
		);
		const args = [
			"wrangler",
			"deploy",
			"--config",
			path.join(ROOT, "build/server/wrangler.json"),
			"--keep-vars",
		];
		if (Object.keys(secrets).length) {
			await writeFile(secretFile, JSON.stringify(secrets), { mode: 0o600 });
			args.push("--secrets-file", secretFile);
		}
		await run("npx", args, buildEnv);
		console.log(`部署完成：${config.name}。已有 DO、R2 和 Secret 均继续沿用。`);
		return summary;
	} finally {
		await rm(generated, { force: true });
		await rm(secretFile, { force: true });
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	deploy({ planOnly: process.argv.includes("--plan") }).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
