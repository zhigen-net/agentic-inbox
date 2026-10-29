<div align="center">
  <h1>Agentic Inbox</h1>
  <p><em>A self-hosted email client with an AI agent, running entirely on Cloudflare Workers</em></p>
</div>

Agentic Inbox lets you send, receive, and manage emails through a modern web interface -- all powered by your own Cloudflare account. Incoming emails arrive via [Cloudflare Email Routing](https://developers.cloudflare.com/email-routing/), each mailbox is isolated in its own [Durable Object](https://developers.cloudflare.com/durable-objects/) with a SQLite database, and attachments are stored in [R2](https://developers.cloudflare.com/r2/).

An **AI-powered Email Agent** can read your inbox, search conversations, and draft replies -- built with the [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/) and [Workers AI](https://developers.cloudflare.com/workers-ai/).

![Agentic Inbox screenshot](./demo_app.png)

Read the blog post to learn more about Cloudflare Email Service and how to use it with the Agents SDK, MCP, and from the Wrangler CLI: [Email for Agents](https://blog.cloudflare.com/email-for-agents/).

## How to setup

**Important**: Clicking the 'Deploy to Cloudflare' button is only one part of the setup. You must follow the **After deploying** steps as well. For a full step-by-step guide with screenshots, refer to this comment:
https://github.com/cloudflare/agentic-inbox/issues/4#issuecomment-4269118513

### To set up

1. Deploy to Cloudflare. The deploy flow will automatically provision R2, Durable Objects, and Workers AI. You'll be prompted for **DOMAINS**, which is the domain (yourdomain.com) you want to receive emails for (email@yourdomain.com).

   [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/cloudflare/agentic-inbox)

2. **Optional legacy Cloudflare Access bridge** -- Enable [one-click Cloudflare Access](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/) on your Worker under Settings > Domains & Routes. The modal will show your `POLICY_AUD` and `TEAM_DOMAIN` values. `TEAM_DOMAIN` can be either your Access team URL or the full `.../cdn-cgi/access/certs` URL. **You must set these as secrets for your Worker.**
3. **Set up Email Routing** -- In the Cloudflare dashboard, go to your domain > Email Routing and create a catch-all rule that forwards to this Worker
4. **Enable Email Service** -- The worker needs the `send_email` binding to send outbound emails. See [Email Service docs](https://developers.cloudflare.com/email-routing/email-workers/send-email-workers/)
5. **Configure team permissions** -- Follow [the team deployment guide](docs/team-deployment.zh-CN.md) to configure D1 and the bootstrap administrator before the first login.
6. **Create a mailbox** -- Visit your deployed app and create a mailbox for any address on your domain (e.g. `hello@example.com`)

### Account setup

Existing Access users can set an independent password in Account settings. A new installation uses a random `BOOTSTRAP_TOKEN` at `/setup`. If the whole Worker is still protected by Access, ordinary users cannot reach registration until its outer policy is adjusted. See [the account guide](docs/accounts-mailboxes.zh-CN.md).

## Features

- **Full email client** — Send and receive emails via Cloudflare Email Routing with a rich text composer, reply/forward threading, folder organization, search, and attachments
- **Per-mailbox isolation** — Each mailbox runs in its own Durable Object with SQLite storage and R2 for attachments
- **Built-in AI agent** — Side panel with 9 email tools for reading, searching, drafting, and sending
- **Auto-draft on new email** — Agent automatically reads inbound emails and generates draft replies, always requiring explicit confirmation before sending
- **Configurable and persistent** — Custom system prompts per mailbox, persistent chat history, streaming markdown responses, and tool call visibility

## Stack

- **Frontend:** React 19, React Router v7, Tailwind CSS, Zustand, TipTap, `@cloudflare/kumo`
- **Backend:** Hono, Cloudflare Workers, Durable Objects (SQLite), R2, Email Routing
- **AI Agent:** Cloudflare Agents SDK (`AIChatAgent`), AI SDK v6, Workers AI (`@cf/moonshotai/kimi-k2.5`), `react-markdown` + `remark-gfm`
- **Auth:** Independent password accounts and secure sessions; optional verified Cloudflare Access bridge for existing users

## Getting Started

```bash
npm ci
npx wrangler d1 migrations apply DIRECTORY --local
npm run dev
```

### Configuration

1. Set your domain in `wrangler.jsonc`
2. Follow the Workers Builds guide below; the deployment script provisions or reuses storage automatically.

### Deploy

Configure Cloudflare Workers Builds with the deploy command:

```bash
npm run cf:deploy
```

For a read-only local resource check, set the target account and `APP_NAME`, then run `npm run cf:deploy -- --plan`.

## Prerequisites

- Cloudflare account with a domain
- [Email Routing](https://developers.cloudflare.com/email-routing/) enabled for receiving
- [Email Service](https://developers.cloudflare.com/email-service/) enabled for sending
- [Workers AI](https://developers.cloudflare.com/workers-ai/) enabled (for the agent)
- [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) optional for the legacy login bridge; independent accounts protect the application

This fork provides independent user accounts, invitation or approval registration, user management, mailbox assignment and self-service creation with domain permissions and quotas. When creating a mailbox, select multiple domains to generate same-prefix addresses sharing one inbox. Mailbox switching, sender selection, address activation and domain management are available in the app.

**Existing admins:** keep using the verified Access login, open Account settings and set an independent password first. After verifying password login, adjust the outer Cloudflare Access policy to let other users register and sign in directly. Deployment does not remove that policy automatically. New installations can initialize the configured admin using a random `BOOTSTRAP_TOKEN` at `/setup`.

**Deploy like CRM-Lite:** connect Cloudflare Workers Builds, leave Build command empty and set Deploy command to `npm run cf:deploy`. During development, feature PRs may merge directly into `main`. Disable preview builds. The script reuses storage, provisions missing resources, applies additive migrations and deploys with `--keep-vars`.

Existing DO and R2 mappings stay unchanged. Legacy mailbox directories are automatically reconciled so old mailboxes remain visible. See [独立账号与多域名邮箱](docs/accounts-mailboxes.zh-CN.md) and [Workers Builds 部署](docs/team-deployment.zh-CN.md) for account setup, multi-address behavior and upgrade instructions.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │────>│  Hono Worker     │────>│  MailboxDO      │
│  React SPA   │     │  (API + SSR)     │     │  (SQLite + R2)  │
│  Agent Panel │     │                  │     └─────────────────┘
└──────┬───────┘     │  /agents/* ──────┼────>┌─────────────────┐
       │             │                  │     │  EmailAgent DO  │
       │ WebSocket   │                  │     │  (AIChatAgent)  │
       └─────────────┤                  │     │  9 email tools  │
                     │                  │────>│  Workers AI     │
                     └──────────────────┘     └─────────────────┘
```

## License

Apache 2.0 -- see [LICENSE](LICENSE).

### Domain onboarding

The admin domain wizard separates DNS, routing, provider permissions and actual delivery checks. It supports reviewed Cloudflare configuration plans, encrypted account connections, cross-account ingress Workers and optional Resend sending. See [域名检查与配置指南](docs/domain-onboarding.zh-CN.md) for permissions, setup and external-provider limitations.
