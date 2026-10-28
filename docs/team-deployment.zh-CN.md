# 内部团队版：Workers Builds 部署

本项目沿用 CRM-Lite 的部署方式：Cloudflare 连接 GitHub，push 后由 **Workers Builds** 执行 `npm run cf:deploy`。GitHub Actions 仅检查代码，不负责部署，也不需要 GitHub Secrets。

## 固定环境和发布流程

| 环境 | Git 分支 | Worker                          |
| ---- | -------- | ------------------------------- |
| 测试 | `dev`    | `agentic-inbox-dev`（建议名称） |
| 生产 | `main`   | 已有 `agentic-inbox`            |

当前开发阶段按用户决定：功能分支可以直接开 PR 合入 `main`，由现有 `agentic-inbox` 的 Workers Builds 自动部署，暂不要求先经过 `dev`。`dev` 保留为可选测试分支；以后启用独立测试环境时，再恢复 dev → main 流程。

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

## 独立账号与管理员

当前版本使用独立密码账号和会话。`ADMIN_EMAILS` 是首位管理员登录邮箱；已有 `POLICY_AUD` / `TEAM_DOMAIN` 继续保留，作为旧 Access 账号的过渡入口。

- 已有管理员：部署后进入“账号设置”设置独立密码，验证后再调整覆盖全站的 Access 门禁。
- 全新安装：额外配置随机 `BOOTSTRAP_TOKEN`（至少 32 位），访问 `/setup` 设置管理员密码；初始化只在尚无管理员密码时有效。
- 构建脚本必需 `ADMIN_EMAILS`，其余三个 Secret 仅在提供且线上尚不存在时初始化，已有值永不覆盖。
- Cloudflare 外层 Access 策略不会由代码部署自动删除。不移除全站门禁时，外部用户仍需先通过 Access。

完整用户、域名、多地址和旧数据说明见 [独立账号与多域名邮箱](accounts-mailboxes.zh-CN.md)。

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

- 原有 Worker 的普通变量会保留。`DOMAINS` 用于首次导入旧配置；之后在应用后台管理域名和用户域名权限。
- 新环境可通过构建变量 `INBOX_DOMAINS` 设置域名；用于初始 `DOMAINS` 配置；目录初始化完成后以应用数据库为准。
- 每个正式收信域名仍需单独配置 Email Routing/DNS，转发到生产 Worker。发信域名需单独完成 Email Service 验证。
- 既有 Mailbox DO、R2 邮件附件和邮箱设置保持原位，不会为生产环境新建替代桶。
- 管理员首次访问会自动核对旧邮箱目录；也可登录 → **管理后台 → 邮箱与授权 → 重新核对旧邮箱目录**，将原邮箱接入新权限目录。导入按页执行，可重复运行，不会恢复已停用邮箱。
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

本地也使用独立账号。在未提交的 `.dev.vars` 设置 `ADMIN_EMAILS` 和随机 `BOOTSTRAP_TOKEN`，首次打开 `/setup` 设置密码；不再通过开发变量自动假扮用户。

提交前：

```bash
npm test
npm run typecheck
npm run build
```

测试包含权限、API、MCP、收信路由、真实 workerd/D1/DO/Agent 撤权，以及自动部署的资源保留、迁移顺序和失败保护。测试不发送真实邮件、不调用付费 AI。

## MCP 与回滚

`/mcp` 使用无状态 Streamable HTTP。外部客户端需要有效的原生用户会话；过渡期间也接受已验证的用户 Access JWT；旧 SSE 会话或仅持有 Access Service Token 的客户端不再具有用户权限。客户端调用的每个工具都检查当前邮箱授权。

回滚使用 Cloudflare Worker 的历史部署。数据库迁移不回退，必须保持向后兼容。回滚到不含团队权限的旧版前，应先把 Access 策略限制为管理员，防止恢复旧版“全部 Access 用户可操作全部邮箱”的行为。不要清空 D1 来回滚。
