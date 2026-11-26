---
name: monitoring-analysis
description: 分析监控指标（CPU、内存、磁盘、网络、容量、throttling 和告警），定位异常对象、时间窗和影响范围，只产出证据和建议。
---

# 监控分析

> 平台执行约定：只读工具直接调用；变更工具会返回 `awaiting_approval`，说明平台已挂起等审批，不要重复调用同一个变更，也不要调用 `task.*`、`approval.*`。审批被拒绝或工具失败时如实说明，不要绕过审批。只使用当前任务工具清单里的工具；示例里的 server 名（`mcp.k8s`、`mcp.es`、`mcp.vm`）以实际清单为准，不要直接连上游 MCP，也不要用 kubectl/helm 代替只读查询。

目标：从指标里确认哪个对象异常、从什么时候开始、是否触达限额，再结合 K8s 和日志解释原因。不要把重启或扩容当成第一步。

## 分析路径

1. 明确对象和时间窗：Pod、工作负载或节点；对比 15 分钟、1 小时、24 小时，容量判断用前一天同一时段做基线。
2. 用 `knowledge.search` 查容量 runbook、服务 SLO 和限额约定，保留 source。
3. 指标查询（`mcp.vm.*`）：
   - 先用 `query` 确认当前值，再用 `query_range` 看趋势，时间窗至少覆盖故障前后 1 小时。
   - 用具体 namespace/pod/node/container label 收窄，先粗后细，不要拉全集群序列。
   - 关注 CPU 使用率与 requests/limits 的比例、throttling、内存 working set 与 OOM、节点 allocatable 压力、磁盘使用率和 inode、网络丢包和重传、容器重启次数。
   - 记录实际使用的 PromQL/MetricsQL、步长、时间范围和单位；只引用明显异常或越过阈值的序列。
   - 正则转义（高频报错）：双引号字符串按 Go 规则解析，点号要写成 `\\.`，例如 `{instance=~".*17\\.(10|11|12)"}`；也可以改用字符类 `{instance=~".*17[.](10|11|12)"}` 或反引号原始字符串。不要写成 `\.`，否则 VictoriaMetrics 返回 `cannot parse string literal`。返回该错误时按提示修正同一查询，不要换工具或扩大时间窗。
4. 交叉验证：
   - K8s（`mcp.k8s.*`）：`k8s_get pods`、`k8s_get deployment`、`k8s_get nodes` 确认副本、调度、重启和 HPA；指标里的对象必须能在集群里找到，名字对不上时说明。
   - 日志（`mcp.es.*`）：原因不明时按 `host`/`host_ip`/`ident` 和时间窗查 `mcp.es.search`，验证错误是否集中在同一时间段。
5. 不要为了「归属」额外调 `asset.get`：资产没登记不影响指标结论，只写对象和证据。

## 日志字段提醒

索引 `dw_syslog_YYYY.MM.DD` 按天；字段只有 `@timestamp`、`filebeat_time`、`host`、`host_ip`、`ident`（程序名）、`message`、`pri`、`pid`、`time`。没有 `program`、`severity`、`log.level`，写错返回 0 条；ES 8.3.2 不支持 `esql`，用 `search` 加 query DSL。

## 结论要求

- 只写高于限额或基线的序列：对象、指标、数值、时间窗、对比基线、查询语句。
- 区分请求量增长和单实例热点：副本少、限流高、单 Pod 吃满要分开说。
- 不贴全量序列表；查询没有数据的指标明确说没有。
- 没有返回的证据不写，工具报错或缺少工具时说明缺什么。

## 变更边界

- 扩容、改 requests/limits、重启都算变更，本技能只给建议和影响评估。
- 用户明确要求执行时走平台变更工具和审批；未批准不得声称已执行，没有写权限工具时直说。