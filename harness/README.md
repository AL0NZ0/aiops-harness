# harness

这里不放 DeepSeek Harness 的改过的源码。引擎升级时，整份替换引擎，然后只回归本仓库的扩展层。

平台要接进引擎时，用官方 MCP client 拉起：

```sh
AIOPS_API=http://127.0.0.1:8787 \
AIOPS_INTERNAL_TOKEN=dev-internal-token \
AIOPS_ACTOR=alice \
npm run mcp
```

工作目录是本仓库根目录。连接地址、凭据和审批都在平台里，不写进 Skill。具体的 client 字段以当前 dsh 版本文档为准，每个外部 MCP server 单独一条。

MCP 代理除知识/运维工具外，还暴露 `task.create`、`task.finish`、`task.get`、`task.cancel`、`approval.list`、`approval.resume`。DSH 的标准流程是先 `task.create`，后续工具调用挂到任务下；变更停在审批，批准后 `approval.resume`，最后 `task.finish`。不使用任务工具时按 `adhoc:<actor>` 记审计。
