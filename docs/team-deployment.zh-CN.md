# 内部团队版部署与迁移

该版本保留原有的每邮箱 Durable Object、邮件数据和 R2 对象；新增 D1 存储用户、邮箱目录和授权关系。生产环境必须同时通过 Cloudflare Access 身份验证和应用账户检查。

## 权限

| 身份              | 权限                                                      |
| ----------------- | --------------------------------------------------------- |
| 团队管理员        | 邀请/停用成员、分配邮箱、修改邮箱设置、访问所有启用的邮箱 |
| 邮箱 Editor       | 阅读、搜索、收发信、草稿、文件夹、标记和删除邮件          |
| 邮箱 Viewer       | 阅读、搜索、下载附件；不能改动邮件或发信                  |
| 未邀请/已停用成员 | 无法进入应用                                              |

同一个邮箱分配给多名成员就是共享邮箱。已读状态、星标、文件夹和草稿由成员共享。AI 对话按 `用户ID~邮箱地址` 分离；成员不能读取其他人的 AI 对话。原有邮箱级 Agent 数据保留，收信自动草稿继续在独立的邮箱级 Agent 中运行，生成的草稿显示在共享草稿箱。

## 上线前

1. 确认实际 Cloudflare 账户、Worker 名称、生产地址，以及构建是否由 GitHub 推送自动触发。不要仅依据仓库名称推断部署目标。
2. 导出现有 Worker 配置，记录 R2 桶、DO 绑定/命名空间和 Access 的 `TEAM_DOMAIN`、`POLICY_AUD`，并按现有备份流程备份重要邮件。不要把密钥写入 Git。
3. 保留 `MAILBOX`、`EMAIL_AGENT`、`EMAIL_MCP` 的名称和现有迁移；不要重建 R2 桶或 DO 命名空间。此版本没有修改它们的存储标识。
4. 安排一次短暂维护窗口：新版在 D1 初始化和旧邮箱导入完成前不会向成员展示邮箱。

## 创建目录数据库

以下命令必须指向正确的 Cloudflare 账户：

```bash
npx wrangler d1 create agentic-inbox-directory
```

将返回的数据库 ID 填入 `wrangler.jsonc` 的 `d1_databases[0].database_id`，替换全零占位值。保留绑定名 `DIRECTORY`，然后：

```bash
npx wrangler d1 migrations apply DIRECTORY --remote
```

只创建三张业务表：`users`、`mailboxes`、`mailbox_members`。邮件正文和附件不会复制到 D1。

## 配置管理员和域名

在 `wrangler.jsonc` 中配置：

```jsonc
"vars": {
  "DOMAINS": "ie8.net,second-domain.example",
  "EMAIL_ADDRESSES": []
}
```

使用 Worker Secret 设置首位管理员邮箱，避免将登录邮箱提交到公开仓库：

```bash
npx wrangler secret put ADMIN_EMAILS
# 在交互提示中输入首位管理员的 Access 登录邮箱。
```

- `ADMIN_EMAILS` 是首位/应急管理员的 Access 登录邮箱，允许逗号分隔。只应填写可信的已验证身份，不要填写邮箱域名通配符。
- 配置的管理员在首次登录时创建账户，随后绑定其已验证 JWT 的 `issuer + sub`；现有成员不会因为修改这个变量自动升级为管理员。后续管理员可在团队管理页分配。
- 普通成员需要先由管理员邀请，再通过 Access 登录。邀请不会发送邮件；请自行告知成员访问地址。Cloudflare Access 策略也必须允许该成员。
- `DOMAINS` 是应用允许创建和投递的邮箱域名列表。每个域名分别配置 Email Routing/DNS 并投递到同一个 Worker。发信域名须在 Email Service 中单独验证。
- `EMAIL_ADDRESSES` 非空时继续作为全局地址白名单；不是用户授权列表。成员可访问哪些邮箱由 D1 授权决定。
- `POLICY_AUD` 和 `TEAM_DOMAIN` 沿用生产 Worker 的 Secrets。切勿在仓库里填写令牌。
- `DEV_USER_EMAIL` 仅在本地开发模式生效，生产环境始终验证 Access JWT，不使用开发身份。

## 发布和导入

```bash
npm ci
npm test
npm run typecheck
npm run build
# 审查代码与部署目标后，发布生产版本：
npx wrangler deploy
```

如果原 Worker 名称不是 `agentic-inbox`，先将配置中的 `name` 改成真实名称。保持现有桶和 DO 绑定，检查构建配置没有覆盖生产 Secrets。

1. 首位管理员登录，进入首页的 **Team administration**。
2. 点击 **Import existing mailboxes**。导入按页执行，可重复运行，不会重新启用已停用邮箱；只导入当前域名/地址配置允许的邮箱。
3. 管理员可以立即查看导入的邮箱。普通成员在分配权限之前看不到任何邮箱。
4. 邀请成员，选择邮箱，将其授予 Editor 或 Viewer。共享邮箱可分配给多个成员。
5. 在首页创建新邮箱；在管理页分配给成员。

停用邮箱会拒收新邮件、撤销成员授权，但保留邮件、设置和附件。管理页可以恢复；恢复后需要重新分配成员。创建过程中失败、已经留下设置对象的邮箱，也可在管理页检查后恢复。

## MCP 兼容性

`/mcp` 使用无状态 Streamable HTTP，每个请求绑定当前验证过的用户，并在工具执行时检查最新授权。不再使用共享的 MCP Durable Object 会话；旧客户端需要重新连接到 `/mcp`，旧 `/mcp/sse` 会话不再提供服务。

外部客户端必须发送有效的用户 Cloudflare Access JWT（由 Access 传入 `cf-access-jwt-assertion`）。仅持有 Access Service Token 不再具有任何用户权限；本版没有实现服务账号代理、独立 OAuth 登录或长期 API Key。浏览器能登录不代表任意外部 MCP 客户端已经完成认证。

## 验收

- 两个不同 Access 用户登录，分别只能看到分配的邮箱。
- Viewer 可以读信、搜索和下载附件；API、AI 工具和 MCP 都不能借此发信或修改草稿。
- 编辑者可以处理共享邮箱；只有管理员能修改设置和成员。
- 修改 URL、Agent 名称或 MCP `mailboxId` 不会访问其他邮箱/用户。
- 已连接 Agent 在下一次消息或工具操作时检查撤权；不会仅依赖连接建立时的权限。已经发到客户端的数据不能回收。
- 给多个本地邮箱、CC、BCC 地址分别投递，按 SMTP 信封收件人落入对应邮箱。
- 每个域名分别验证真实收发信、附件及自动草稿；本地自动测试不发送真实邮件、不调用付费模型。

## 开发和测试

需要 Node.js 24（测试使用内置 SQLite）。

```bash
npm ci
npx wrangler d1 migrations apply DIRECTORY --local
npm run dev
```

本地默认管理员是 `admin@localhost.test`。如果设置了 `ADMIN_EMAILS`，在未使用 Access 的本地开发中，还需在未提交的 `.dev.vars` 设置 `DEV_USER_EMAIL` 为该管理员邮箱。切换开发用户需重启服务，不能通过浏览器自报身份。

`npm test` 包括真实 SQL 上的权限/API/MCP/收信测试，以及 Miniflare/workerd 中真实 D1、Mailbox DO 事务、Agent 私人历史和 WebSocket 撤权测试。CI 只检查代码，不会部署。

## 回滚

D1 目录是增量改造，原有邮件存储仍然存在。但旧版应用采用“所有 Access 用户可操作全部邮箱”的权限模型。回滚 Worker 之前，应先把 Access 策略限制为管理员，避免普通成员恢复旧版的全邮箱访问权限。不要通过清空 D1 来回滚。
