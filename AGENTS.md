# 开发与发布约定

## 分支和部署（用户长期偏好：沿用 CRM-Lite 的方式）

- 使用 Cloudflare Workers Builds 自动部署；部署命令是 `npm run cf:deploy`，构建命令留空、根目录为 `/`。
- 当前开发阶段（用户决定）：功能分支可以直接开 PR 合入 `main`，由生产 Worker 的 Workers Builds 自动部署；暂不要求先经过 `dev`。
- `dev` 保留作为可选测试分支；以后启用独立测试环境时，再按用户指示恢复 dev → main 流程。
- 每个环境关闭 Workers Builds 的 Preview Builds / Preview branches。它与 workers.dev 版本预览开关不是同一项设置。
- GitHub Actions 只做测试和构建检查，不承担部署，不要求在 GitHub 保存 Cloudflare Secret。
- 发布入口为 `scripts/cf-deploy.sh` / `scripts/cf-deploy.mjs`。Worker 名取 `WRANGLER_CI_OVERRIDE_NAME`，本地使用 `APP_NAME`。目标账户必须明确指定，不能假定当前默认账户正确。
- `wrangler.jsonc` 中的资源名和 D1 ID 是占位符。临时配置、真实资源 ID 和 Secret 不提交到 Git。
- 已有环境优先采用线上 `BUCKET` / `DIRECTORY` 绑定；不要因命名规则变化重建邮件桶或 DO。新环境自动分配独立资源。
- 已有 Access / 管理员 Secrets 不覆盖、不轮换。普通控制台变量通过 `--keep-vars` 和现有配置保留。

## 用户和地址模型

- 登录账号与邮箱独立。创建邮箱时多选域名生成同前缀地址，不引入主/附域名组或自动跨域名同步。
- 所有地址映射到一个稳定邮箱。`address` 是兼容旧 DO/R2 的永久存储键；不能随默认发件地址或界面名称修改。
- 域名、收发开关、用户创建权限由 D1 管理；不要用前端多选框代替后端权限或事务校验。
- 停用地址保留占用权，不释放给其他用户。新增地址冲突必须整体回滚。
- 独立会话采用 HttpOnly/Secure Cookie。旧 Access 仅作为验证过的过渡身份，禁止信任未验签邮件头。
- 初始管理员必须有受信任的 Access 身份或随机初始化凭据；不能凭配置的管理员邮箱公开抢注。
- 不在代码升级时自动关闭外层全站 Access；先确保管理员已建立并验证原生密码登录。

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

## 界面一致性

- 我的邮箱、账号与安全、管理后台共用 PortalShell 的导航和账号入口；不要为首页另建一套导航逻辑。
- 首页可减少内容区的装饰和统计占用，保留紧凑邮箱列表与快捷入口；页面切换时导航位置和操作方式保持一致。
