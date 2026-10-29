export type CheckState =
	| "passed"
	| "missing"
	| "permission"
	| "unknown"
	| "error"
	| "warning";
export interface DomainCheck {
	id: string;
	label: string;
	state: CheckState;
	detail: string;
	records?: string[];
}
export interface DNSRecord {
	type: string;
	name: string;
	content: string;
	priority?: number;
}
export interface DomainHealth {
	checkedAt: string;
	checks: DomainCheck[];
	requiredRecords: DNSRecord[];
	zoneId?: string;
	workerName?: string;
	crossAccount: boolean;
	lastReceiveAt?: string;
	lastSendAt?: string;
	lastSendError?: string;
}
export interface ProviderConnection {
	id: string;
	name: string;
	provider: "cloudflare" | "resend";
	account_id: string | null;
	created_at: string;
}
export interface DomainSetup {
	connection_id: string | null;
	send_connection_id: string | null;
	setup_mode: "cloudflare" | "external";
	zone_id: string | null;
	worker_name: string | null;
	dkim_selector: string;
}
export interface DomainPlan {
	id: string;
	expiresAt: number;
	blockers: string[];
	warnings: string[];
	changes: string[];
	health: DomainHealth;
}
