# 开发与发布约定

## 分支和部署（用户长期偏好：沿用 CRM-Lite 的方式）

- 使用 Cloudflare Workers Builds 自动部署；部署命令是 `npm run cf:deploy`，构建命令留空、根目录为 `/`。
- `dev` 分支对应独立测试 Worker，验证通过后再从 `dev` 合入 `main` 更新生产 Worker。
- 功能分支从 `dev` 拉出，PR 指向 `dev`。不要直接推送 `main`，不要把功能分支直接合入生产。
- 每个环境关闭 Workers Builds 的 Preview Builds / Preview branches。它与 workers.dev 版本预览开关不是同一项设置。
- GitHub Actions 只做测试和构建检查，不承担部署，不要求在 GitHub 保存 Cloudflare Secret。
- 发布入口为 `scripts/cf-deploy.sh` / `scripts/cf-deploy.mjs`。Worker 名取 `WRANGLER_CI_OVERRIDE_NAME`，本地使用 `APP_NAME`。目标账户必须明确指定，不能假定当前默认账户正确。
- `wrangler.jsonc` 中的资源名和 D1 ID 是占位符。临时配置、真实资源 ID 和 Secret 不提交到 Git。
- 已有环境优先采用线上 `BUCKET` / `DIRECTORY` 绑定；不要因命名规则变化重建邮件桶或 DO。新环境自动分配独立资源。
- 已有 Access / 管理员 Secrets 不覆盖、不轮换。普通控制台变量通过 `--keep-vars` 和现有配置保留。

## 数据与权限

- D1 迁移必须向后兼容；只添加表、字段和索引。迁移先于 Worker 发布，控制台代码回滚不会回退数据库。
- 保留现有 Mailbox DO 名称和 R2 对象键。停用邮箱应保留邮件和附件。
- API、Agent 和 MCP 必须使用同一权限服务。不能仅靠前端隐藏控件或 Agent 提示词实现隔离。
- AI 对话按用户与邮箱隔离；WebSocket 消息和工具执行都检查最新权限。
- 部署脚本的 `--plan` 必须保持只读，不能创建资源、迁移数据或发布代码。

## 验证

- Node.js 24，依赖使用 `npm ci`。
- 提交前运行 `npm test`、`npm run typecheck`、`npm run build`。
- 修改发布逻辑时覆盖已有资源沿用、新环境隔离、迁移失败阻止发布和 Secret 保留的测试。
