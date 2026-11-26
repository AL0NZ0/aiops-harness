---
name: k8s-troubleshooting
description: 排查 Kubernetes 工作负载异常（CrashLoopBackOff、Pending、ImagePullBackOff、OOMKilled、未就绪、服务无响应），并联动节点 syslog 与监控 MCP 交叉验证。
---

# Kubernetes 排查

> 平台执行约定：只读工具直接调用；变更工具会返回 `awaiting_approval`，说明平台已挂起等审批，不要重复调用同一个变更，也不要调用 `task.*`、`approval.*`。审批被拒绝或工具失败时如实说明，不要绕过审批。只使用当前任务工具清单里的工具；示例里的 server 名（`mcp.k8s`、`mcp.es`、`mcp.vm`）以实际清单为准，不要直接连上游 MCP，也不要用 kubectl/helm 代替只读查询。

目标：先定位是哪个工作负载或节点、什么原因、影响多大，再用日志和监控确认。只报告工具实际返回的证据，不把「可能」写成结论。

## 排查顺序

1. 明确对象和时间窗：namespace、工作负载名、Pod 名、现象开始时间。信息不全时用窄范围查询补，不要猜资源名。
2. 用 `knowledge.search` 查对应服务的 runbook，结论保留 source。
3. 看集群资源：
   - `k8s_get` 列 Pod，用 namespace 加 label selector 收窄，看 status、restartCount、ready、nodeName。
   - 异常 Pod 用 `k8s_describe` 看 Conditions、Last State、Exit Code 和 Events，不要对整个 namespace 批量 describe。
   - `k8s_events` 核对 BackOff、FailedMount、Unhealthy、FailedScheduling、OOMKilling。
   - 崩溃循环用 `k8s_logs` 取当前和上一次容器的尾部日志；日志很大时先限制 tail，不要整份拉取。
4. 看近期变更：`k8s_rollout_status`、`k8s_rollout_history`，以及 Deployment/ReplicaSet 的镜像和副本数。节点问题用 `k8s_get nodes` 看 Ready 和 Pressure，`k8s_top_nodes` / `k8s_top_pods` 只作快速参考，数值以监控 MCP 为准。
5. 节点系统日志联动（`mcp.es.*`）：
   - ES 里是主机 syslog（内核、kubelet、containerd/dockerd、systemd、audit、sshd 和主机上的 exporter/agent），不是业务应用日志。容器 stdout 和应用日志用 `k8s_logs`；这里查不到应用异常栈是正常的，不要因此下「没有日志」的结论。
   - 用 Pod 的 `nodeName`（IP）查 `host_ip`，用节点名查 `host`；拿 IP 去查 `host` 一定是 0 条。看同一节点的内核 OOM、磁盘写满、运行时或 kubelet 报错，作为节点层佐证。
   - 索引是 `dw_syslog_YYYY.MM.DD`，按天分开查。
   - 字段只有 `@timestamp`、`filebeat_time`、`host`、`host_ip`、`ident`（程序名，不是 program）、`message`、`pri`（text）、`pid`（text）、`time`。不要写 `program`、`severity`、`host.ip`、`log.level`，写错不会报错但返回 0 条。
   - ES 8.3.2 不支持 `esql`，用 `search` 加 query DSL。
   - 精确匹配单台主机用 `term` + `host.keyword` / `ident.keyword`：`host`、`ident` 是 text 字段，标准分词器按 `-` 切开，`prefix` 或 `match` 会匹配到别的节点；对 `host` 直接做 terms 聚合会 400，聚合一律用 `host.keyword`。
   - 再在 `message` 里搜错误关键词；`@timestamp` 是 UTC，时间窗要和现象对齐。size 控制在 50–100。0 条命中先核对字段名（`host` 还是 `host_ip`）、时区和索引日期，不要直接下「没有日志」的结论。
6. 监控联动（`mcp.vm.*`）：
   - 用 `query_range` 看 CPU、内存、重启次数、容器 throttling、节点压力，时间窗覆盖故障前后（15m/1h/6h）。
   - 查询限定 container/pod/node label，不要拉全集群序列；只引用明显异常的序列，写清数值和单位。
   - 正则里点号写成 `\\.`（如 `{instance=~".*17\\.(10|11|12)"}`）或用 `[.]`，不要写 `\.`；MetricsQL 双引号字符串按 Go 规则解析，写错会返回 `cannot parse string literal`。
7. 不要为了「归属」额外调 `asset.get`：资产没登记不代表排查有问题，结论只写对象和证据。

## 结论要求

- 给出影响对象（namespace/工作负载/Pod/节点）、现象、根因或最可能的 2–3 个方向。
- 每条结论带证据：工具名、关键字段或数值、时间窗、知识库 source。
- 集群、日志、监控三方对不上时按时间线说明差异，不要强行归因。工具报错或缺少工具时直接说明缺什么。

## 变更边界

- 重启、删除、扩容、改配置都是变更。用户没有明确要求时只出证据和建议。
- 用户明确要求时，调用当前工具清单里的变更工具；调用后平台挂起审批，拿到审批结果前不得声称已执行。
- 当前没有写权限工具时直说「平台未接入具备写权限的 MCP server」，不要承诺或模拟执行结果。