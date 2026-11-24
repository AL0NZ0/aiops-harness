# 给自动化 Agent 的工程约束

这份文件给在本仓库里干活的编码 Agent 看。人类读者请先看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 不可放宽的红线

1. **工具只能走 ToolBroker**（`api/src/broker.ts`）：只读自动执行并审计；`risk: mutate` 必须先产生审批。禁止在 HTTP 路由、MCP 代理、前端或任何新入口绕过审批直接调用工具。
2. **审批规则不能放宽**：不能审批自己名下的变更；一个审批只能执行一次；拒绝或取消不能改目标系统；`approval.resume` 必须校验工具、参数 hash 和任务归属。MCP 风险配置和逐工具风险覆盖只有 admin 能改，覆盖必须绑定工具签名，签名不匹配自动回退默认风险。
3. **凭证不回显**：token、密码、API Key、私钥、MCP headers、模型 provider key 只能存在于 `data/` 的 0600 文件里，敏感字段必须经 `api/src/secret-box.ts` 加密落盘；API、页面、事件、日志、审计参数都不能带明文。解密失败必须报错，禁止回退明文或清空数据。
4. **数据文件优先**：`config/*` 只是种子，`data/*.json` 存在时就是权威，启动时不能覆盖用户数据；解析失败要报错，不要静默重置。
5. **MCP-only**：外部系统一律通过上游 `mcp.*` 工具访问，平台没有本地直连工具，也没有 fixture 兜底。
6. **SSH 是高风险能力**：`ssh.exec` 必须是 mutate + 审批；资产只引用一个凭证，密码和私钥不能同时配置；没有信任指纹时 `ssh.test`/`ssh.exec` 直接拒绝，指纹不匹配必须断连，跳过校验的代码不允许合入。
7. **不编造资源名、IP、凭据或事件内容**：结论必须给证据来源（哪个工具、哪条事件、哪个指标）。

## 每次改动必须做

- `npm test`、`npm run typecheck`、`node --check web/app.js` 全绿。
- 行为变化同步更新测试和 `docs/使用手册.md`。
- 涉及审批、凭证、SSH、MCP 配置的改动，在提交信息或 PR 描述里写明安全边界有没有变化。

## 目录约定

```text
api/src/                 平台核心：HTTP、任务、审批、资产、凭证、MCP 配置、SSH
extensions/knowledge/    本地 Markdown 和外部知识库 provider
extensions/ops-tools/    上游 MCP HTTP 客户端
extensions/mcp/          stdio MCP 代理
extensions/aiops-skills/ SKILL.md + playbook.json
web/                     控制台：index.html、app.css、app.js
config/                  种子配置
data/                    运行时数据，不入库，0600
deploy/                  Dockerfile、备份/恢复脚本、K8s 清单
harness/                 不放任何引擎源码
```

改 logo 时要同时更新 `web/logo.png` 和 `web/index.html` 里的内嵌 data URI，只换文件不会更新页面。

## 部署相关

- 平台默认单副本；任务 runner 和 `/mcp` 会话不跨实例。
- 没有写权限的 MCP server 就执行不了写操作——不要声称已对真实集群做了变更。
- 对生产环境的任何写操作，必须先和执行人确认计划与回滚方案。