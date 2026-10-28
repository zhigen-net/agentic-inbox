-- 增量迁移：旧 address 永久保留为 DO/R2 存储键，不因默认发件地址变化而修改。
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('pending','approved'));
ALTER TABLE users ADD COLUMN can_create_mailboxes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN mailbox_limit INTEGER NOT NULL DEFAULT 3;
ALTER TABLE users ADD COLUMN send_limit INTEGER NOT NULL DEFAULT 100;
ALTER TABLE users ADD COLUMN ai_limit INTEGER NOT NULL DEFAULT 50;
ALTER TABLE mailboxes ADD COLUMN stable_id TEXT;
ALTER TABLE mailboxes ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE mailboxes ADD COLUMN default_address TEXT;
ALTER TABLE mailboxes ADD COLUMN owner_id TEXT REFERENCES users(id);
UPDATE mailboxes SET stable_id = lower(hex(randomblob(16))), default_address = address;
CREATE UNIQUE INDEX mailbox_stable_id ON mailboxes(stable_id);
CREATE TABLE domains (
 name TEXT PRIMARY KEY COLLATE NOCASE,
 enabled INTEGER NOT NULL DEFAULT 1,
 receive_enabled INTEGER NOT NULL DEFAULT 0,
 send_enabled INTEGER NOT NULL DEFAULT 0,
 mx_verified INTEGER NOT NULL DEFAULT 0,
 checked_at TEXT
);
CREATE TABLE user_domains (
 user_id TEXT NOT NULL REFERENCES users(id),
 domain TEXT NOT NULL REFERENCES domains(name),
 PRIMARY KEY(user_id,domain)
);
CREATE TABLE mailbox_addresses (
 address TEXT PRIMARY KEY COLLATE NOCASE,
 mailbox_address TEXT NOT NULL REFERENCES mailboxes(address),
 domain TEXT NOT NULL REFERENCES domains(name),
 active INTEGER NOT NULL DEFAULT 1,
 receive_enabled INTEGER NOT NULL DEFAULT 1,
 send_enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX mailbox_addresses_by_mailbox ON mailbox_addresses(mailbox_address);
INSERT OR IGNORE INTO domains(name,receive_enabled,send_enabled)
 SELECT DISTINCT substr(address,instr(address,'@')+1),1,1 FROM mailboxes;
INSERT OR IGNORE INTO mailbox_addresses(address,mailbox_address,domain)
 SELECT address,address,substr(address,instr(address,'@')+1) FROM mailboxes;
CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO app_settings VALUES ('registration_mode','invite');
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL,
 auth_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_by_user ON sessions(user_id);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);
CREATE TABLE account_tokens (
 token_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 kind TEXT NOT NULL CHECK(kind IN ('invite','reset')),
 expires_at INTEGER NOT NULL
);
CREATE TABLE auth_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE operation_log (
 id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL,
 target TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}',
 created_at TEXT NOT NULL DEFAULT(strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER enforce_mailbox_quota BEFORE INSERT ON mailboxes
WHEN NEW.created_by IS NOT NULL AND
 (SELECT role FROM users WHERE id=NEW.created_by) != 'admin'
BEGIN
 SELECT CASE WHEN (SELECT active=0 OR can_create_mailboxes=0 FROM users WHERE id=NEW.created_by)
 THEN RAISE(ABORT,'MAILBOX_CREATION_DENIED') END;
 SELECT CASE WHEN (SELECT count(*) FROM mailboxes WHERE created_by=NEW.created_by AND active=1)
 >= (SELECT mailbox_limit FROM users WHERE id=NEW.created_by)
 THEN RAISE(ABORT,'MAILBOX_QUOTA_EXCEEDED') END;
END;
