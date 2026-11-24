# 参与开发

欢迎提 issue 和 PR。改动前请先确认它没有破坏下面这条底线：**任何变更类工具调用都必须经过审批，平台不会绕开 ToolBroker 直接执行写操作。**

## 本地开发

需要 Node.js 22+。MySQL 是可选依赖：不配数据库时任务、审批、审计存内存，重启即丢，适合开发调试。

```sh
npm install
npm run typecheck
node --check web/app.js
npm test          # 没有 .env 时跳过 MySQL 集成用例
npm start         # config/platform.json，默认只有知识/资产/SSH 工具
```

想连 MySQL 就复制 `.env.example` 成 `.env`（`chmod 600`），或直接用 `docker compose up -d`。容器跑起来后访问 `http://127.0.0.1:8787`。

## 改动约定

- **只走 ToolBroker**：工具调用一律经由 `api/src/broker.ts`；`risk: mutate` 必须先建审批，禁止在 HTTP 路由、MCP 代理或前端绕过。
- **不回显凭据**：token、密码、API Key、私钥、webhook URL 只存 `data/`（0600）并加密，接口、页面、事件、日志、审计都不能带明文。
- **数据文件优先**：`config/` 只是种子，`data/*.json` 一旦存在就是权威，启动时不能覆盖。
- **提交前必跑**：`npm test`、`npm run typecheck`、`node --check web/app.js`。改行为要同步补测试和 `docs/使用手册.md`。
- 代码风格跟现有保持一致：TypeScript strict、无框架前端、中文注释说明「为什么」，不写空泛注释。
- 提交信息用 `type(scope): 摘要`（`feat`/`fix`/`docs`/`test`/`chore`），一个提交只做一件事。

## 不要提交

`.env`、`data/`、`dist/`、`node_modules/`、kubeconfig、任何真实的 token、密码、私钥或带 access_token 的 webhook 地址。示例配置里只写占位值。

## 提交 PR

1. 从 `main` 切分支，PR 描述里写清动机、改动点和验证方式。
2. CI 会跑 typecheck、前端语法检查和测试，必须全绿。
3. 涉及审批、凭证、SSH、MCP 配置的改动，请在描述里单独说明安全边界有没有变化。

提交即表示你同意以 [Apache-2.0](LICENSE) 授权你的贡献。