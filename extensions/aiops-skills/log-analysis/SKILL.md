---
name: log-analysis
description: 用 Elasticsearch 检索系统日志，按主机、程序名和时间窗定位错误、突增和首次异常，输出可复核的统计和证据。
---

# 日志分析

> 平台执行约定：只读工具直接调用；变更工具会返回 `awaiting_approval`，说明平台已挂起等审批，不要重复调用同一个变更，也不要调用 `task.*`、`approval.*`。审批被拒绝或工具失败时如实说明，不要绕过审批。只使用当前任务工具清单里的工具；示例里的 server 名（`mcp.k8s`、`mcp.es`、`mcp.vm`）以实际清单为准，不要直接连上游 MCP，也不要用 kubectl/helm 代替只读查询。

目标：回答「什么错误、哪台主机、哪个程序、从什么时候开始、量级多大」，不要只贴原始日志行。

## 查询流程

1. 明确时间窗、主机或服务、程序名（`ident`）和错误关键词。信息不全时先宽后窄，不要猜主机名。
2. 用 `knowledge.search` 查日志规范、已知错误和对应 runbook，保留 source。
3. 索引是 `dw_syslog_YYYY.MM.DD`，按天分开；跨天要逐天查询。
4. 字段只有这些：`@timestamp`、`filebeat_time`、`host`、`host_ip`、`ident`（程序名，不是 program）、`message`、`pri`（text，facility*8+severity）、`pid`（text）、`time`。
   - 没有 `program`、`severity`、`host.ip`、`log.level`；写错字段不会报错，只会返回 0 条。
   - `host` 是主机名（如 `cce-ig-aztmumpi-zorw2t66-d5cko5e2-2`），`host_ip` 才是 IP。拿 IP 去查 `host` 一定是 0 条。
   - `@timestamp` 是 UTC，时间窗按 UTC 换算。
5. 一律用 `mcp.es.search` 传完整 query DSL。`esql` 工具虽然会出现在工具清单里，但目标 Elasticsearch 8.3.2 没有 ES|QL（8.11+ 才支持），调用只会报错，不要尝试。
   - 先用 term 限定 `host.keyword`、`host_ip` 或 `ident.keyword`，再在 `message` 里搜关键词（error、fail、timeout、refused、panic、OOM、No space、too many）。
   - `host`、`ident` 是 text 字段，标准分词器会按 `-` 和 `_` 切开。精确匹配、`prefix`、`wildcard`、terms 聚合一律用 `.keyword` 子字段（`term: {"host.keyword": "..."}`、`"aggs": {"hosts": {"terms": {"field": "host.keyword"}}}`），不要直接对 `host` 聚合，text 字段聚合会 400。
   - 不要用 `match` 在 `host` 上找单台机器：分词后命中的是别的节点。单机用 `term` + `.keyword`。
   - 用 `@timestamp` 的 range 限定时间；size 控制在 50–100，升序看首次异常，降序看最近记录。
   - 需要按主机或程序统计时用 `host.keyword` / `ident.keyword` 做 terms 聚合，不要拉几千条在本地数。
6. 0 条命中先核对索引日期、字段名、时区和关键词大小写，不要直接下「没有日志」的结论。
7. 关联验证：把日志时间线与 `mcp.vm.*` 指标、`mcp.k8s.*` 事件对齐，确认是不是同一时段、同一对象。
8. 主机上的文件日志（ES 没采集到的）且用户明确要求时，交给 SSH 主机排查处理，不要在日志任务里直接登主机。不要为了「归属」额外调 `asset.get`，资产没登记不影响日志结论。

## 结论要求

- 给出错误类型、首次和末次时间、出现次数、涉及主机和 `ident`，附代表性 `message`（截断并脱敏）。
- 区分「错误量突增」和「长期存在」；突增要给前后对比时间窗和基线。
- 只报告实际返回的日志；不编造主机、程序名或 message。查询报错或没有权限时说明原因。

## 变更边界

- 日志分析不改配置、不清理、不重启服务。
- 用户明确要求清理、轮转或重启时，走平台变更工具和审批；未批准不得声称已执行。