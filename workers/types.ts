// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Omit<
	Cloudflare.Env,
	"DOMAINS" | "EMAIL_ADDRESSES" | "ADMIN_EMAILS"
> {
	DOMAINS: string;
	EMAIL_ADDRESSES: string[];
	DIRECTORY: D1Database;
	ADMIN_EMAILS: string;
	DEV_USER_EMAIL?: string;
	BOOTSTRAP_TOKEN?: string;
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
}
