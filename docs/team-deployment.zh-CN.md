# 内部团队版：Workers Builds 部署

本项目沿用 CRM-Lite 的部署方式：Cloudflare 连接 GitHub，push 后由 **Workers Builds** 执行 `npm run cf:deploy`。GitHub Actions 仅检查代码，不负责部署，也不需要 GitHub Secrets。

## 固定环境和发布流程

| 环境 | Git 分支 | Worker                          |
| ---- | -------- | ------------------------------- |
| 测试 | `dev`    | `agentic-inbox-dev`（建议名称） |
| 生产 | `main`   | 已有 `agentic-inbox`            |

功能分支先开 PR 到 `dev` → 测试环境自动部署 → 验证通过后由 `dev` 开 PR 到 `main` → 生产自动部署。不要把功能分支直接合入生产。

每个 Worker 都必须关闭 **Preview Builds / Preview branches**；这与 workers.dev 的版本预览开关不是同一项设置。测试环境使用独立的 D1、R2 和 DO，不接入生产邮件投递。

## 每个环境一次的 Cloudflare 配置

打开已有 Worker 的 **Settings → Build → Connect**（新环境选择 Import a repository），按以下设置连接仓库：

| 设置项            | 值                                              |
| ----------------- | ----------------------------------------------- |
| Repository        | `zhigen-net/agentic-inbox`                      |
| Production branch | 测试 Worker 为 `dev`，生产 Worker 为 `main`     |
| Build command     | 留空                                            |
| Deploy command    | `npm run cf:deploy`                             |
| Root directory    | `/`                                             |
| API token         | 选择能访问目标账户 Workers、D1、R2 的自建 Token |
| Preview Builds    | 关闭                                            |

在 Build variables 中设置 `NODE_VERSION=24`。脚本要求 `CLOUDFLARE_ACCOUNT_ID` 与部署账户一致；如果构建环境没有自动提供，将其作为构建变量填写。Workers Builds 提供 `CLOUDFLARE_API_TOKEN` 和 `WRANGLER_CI_OVERRIDE_NAME`，不要把 Token 写入 Git。

部署 Token 权限：Account Settings Read、Workers Scripts Edit、Workers R2 Storage Edit、D1 Edit，以及 Wrangler 查询账户身份所需的 User Details Read / Memberships Read。Workers AI 和 Email Service 仍需在对应账户启用。默认自动生成的 Builds Token 可能缺少 D1 权限，应选择自建 Token。

## 首次发布的 Access 与管理员

本应用使用 Cloudflare Access，不能像 CRM 的密码登录那样自动生成管理员密码。以下配置需要提供一次：

| Secret         | 内容                                       |
| -------------- | ------------------------------------------ |
| `POLICY_AUD`   | 此 Worker 的 Access 应用 audience          |
| `TEAM_DOMAIN`  | Access team URL 或完整 certs URL           |
| `ADMIN_EMAILS` | 首位管理员的 Access 登录邮箱，支持逗号分隔 |

可在 Worker 的 Variables & Secrets 中设置，也可以在 Workers Builds 的构建 Secrets 中提供。部署脚本只把线上缺失的 Secret 通过部署请求初始化；已有 Secret 永不覆盖或轮换。构建日志不会输出 Secret 的值。首位管理员邮箱不要提交到公开仓库。

已有生产 Worker 的 `POLICY_AUD` / `TEAM_DOMAIN` 会沿用，只需补上 `ADMIN_EMAILS`。测试 Worker 应配置自己的 Access 应用。缺少必要 Secret 时脚本停止，不会发布一个不可登录的版本；配置后在 Builds 中重试。

普通成员需要管理员在 Team administration 中邀请，并且也应被 Access 策略允许。邀请不发送邮件，成员需使用同一个受信任的 Access 邮箱登录；首次登录后绑定已验证的 `issuer + sub`。

## 每次自动部署会做什么

1. 使用 Workers Builds 提供的 Worker 名和目标账户，读取现有绑定。
2. 沿用现有 R2 `BUCKET` 和 D1 `DIRECTORY`。新环境自动创建 `<Worker名>-store` 与 `<Worker名>-directory`；现有 `agentic-inbox` 的桶仍是原来的 `agentic-inbox`。
3. 生成临时 `wrangler.deploy.json`，自动填写数据库 ID，不修改仓库配置。
4. 构建 React Router 前后端，生成 `build/server/wrangler.json`。
5. 执行 D1 迁移；迁移失败则不发布。
6. 发布 Worker 与静态资源，使用 `--keep-vars` 保留控制台变量，并仅初始化缺失 Secret。
7. 清理临时配置和 Secret 文件。

不需要手动创建 D1、抄写数据库 ID，也不需要在 GitHub 配置 Token。`wrangler.jsonc` 中的资源名和全零 D1 ID 始终是占位符。

## 域名和旧邮件

- 原有 Worker 的 `DOMAINS`、`EMAIL_ADDRESSES` 及其它普通变量会保留。可在控制台将 `DOMAINS` 设置为逗号分隔的域名。
- 新环境可通过构建变量 `INBOX_DOMAINS` 设置域名；设置时会明确覆盖该环境的 `DOMAINS`。
- 每个正式收信域名仍需单独配置 Email Routing/DNS，转发到生产 Worker。发信域名需单独完成 Email Service 验证。
- 既有 Mailbox DO、R2 邮件附件和邮箱设置保持原位，不会为生产环境新建替代桶。
- 首次升级后，管理员登录 → **Team administration → Import existing mailboxes**，将原邮箱接入新权限目录。导入按页执行，可重复运行，不会恢复已停用邮箱。
- 管理员访问全部启用邮箱。给成员分配 Editor 或 Viewer；一个邮箱授权多人就是共享邮箱。

| 邮箱角色 | 能力                                       |
| -------- | ------------------------------------------ |
| Editor   | 阅读、搜索、收发信、草稿、文件夹及邮件整理 |
| Viewer   | 阅读、搜索、下载附件；不能修改邮件或发信   |

只有管理员能修改邮箱设置和授权。共享邮箱的已读状态、星标、文件夹和草稿共享；AI 对话按用户与邮箱分离。自动草稿由独立的邮箱级 Agent 执行，草稿保存在邮箱中。旧邮箱级对话数据保留。

停用邮箱会拒收新邮件并撤销成员授权，但保留邮件、设置和附件。管理员可以恢复，随后重新分配成员。

## 只读部署检查

本地核对账户和资源，不创建资源、不迁移、不发布：

```bash
CLOUDFLARE_ACCOUNT_ID=<目标账户ID> APP_NAME=agentic-inbox npm run cf:deploy -- --plan
```

输出会列出计划沿用/创建的资源和缺失的 Secret 名称，不会输出 Secret 值。正常部署由 Workers Builds 执行；本地手动运行同一命令时省略 `-- --plan`，需明确目标账户。

## 本地开发与验证

需要 Node.js 24（测试使用内置 SQLite）。

```bash
npm ci
npx wrangler d1 migrations apply DIRECTORY --local
npm run dev
```

本地默认身份是 `admin@localhost.test`。`.dev.vars` 的 `ADMIN_EMAILS` / `DEV_USER_EMAIL` 示例仅供开发，生产始终验证 Access JWT。切换开发身份需要重启服务。

提交前：

```bash
npm test
npm run typecheck
npm run build
```

测试包含权限、API、MCP、收信路由、真实 workerd/D1/DO/Agent 撤权，以及自动部署的资源保留、迁移顺序和失败保护。测试不发送真实邮件、不调用付费 AI。

## MCP 与回滚

`/mcp` 使用无状态 Streamable HTTP。外部客户端需要有效的用户 Access JWT；旧 SSE 会话或仅持有 Access Service Token 的客户端不再具有用户权限。客户端调用的每个工具都检查当前邮箱授权。

回滚使用 Cloudflare Worker 的历史部署。数据库迁移不回退，必须保持向后兼容。回滚到不含团队权限的旧版前，应先把 Access 策略限制为管理员，防止恢复旧版“全部 Access 用户可操作全部邮箱”的行为。不要清空 D1 来回滚。
