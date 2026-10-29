CREATE TABLE provider_connections (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 provider TEXT NOT NULL CHECK(provider IN ('cloudflare','resend')),
 account_id TEXT,
 credential TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE domains ADD COLUMN connection_id TEXT REFERENCES provider_connections(id);
ALTER TABLE domains ADD COLUMN send_connection_id TEXT REFERENCES provider_connections(id);
ALTER TABLE domains ADD COLUMN setup_mode TEXT NOT NULL DEFAULT 'cloudflare';
ALTER TABLE domains ADD COLUMN zone_id TEXT;
ALTER TABLE domains ADD COLUMN worker_name TEXT;
ALTER TABLE domains ADD COLUMN dkim_selector TEXT NOT NULL DEFAULT '';
ALTER TABLE domains ADD COLUMN health_json TEXT;
ALTER TABLE domains ADD COLUMN last_receive_at TEXT;
ALTER TABLE domains ADD COLUMN last_send_at TEXT;
ALTER TABLE domains ADD COLUMN last_send_error TEXT;
ALTER TABLE domains ADD COLUMN relay_key TEXT;
CREATE TABLE domain_probes (
 address TEXT PRIMARY KEY,
 domain TEXT NOT NULL REFERENCES domains(name),
 expires_at INTEGER NOT NULL,
 received_at TEXT
);
CREATE INDEX domain_probes_expiry ON domain_probes(expires_at);
CREATE TABLE domain_plans (
 id TEXT PRIMARY KEY,
 domain TEXT NOT NULL REFERENCES domains(name),
 fingerprint TEXT NOT NULL,
 enable_sending INTEGER NOT NULL DEFAULT 0,
 expires_at INTEGER NOT NULL,
 used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE relay_receipts (id TEXT PRIMARY KEY, domain TEXT NOT NULL, created_at INTEGER NOT NULL);
ALTER TABLE domains ADD COLUMN setup_changed_at TEXT;
