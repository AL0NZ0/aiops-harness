# k8s MCP k8s_events 修复镜像

上游 `feiskyer/mcp-kubernetes-server` 0.1.12（Python + fastmcp）的 `k8s_events` 在 `sort_by`
排序时把缺失的时间戳当空字符串，和 `datetime` 混排会抛：

```
Error: '<' not supported between instances of 'str' and 'datetime.datetime'
```

触发条件：命名空间里只要有一条事件 `lastTimestamp` 为空，并且调用方传了
`sort_by=lastTimestamp`（平台模型经常这么传）。症状是 `k8s_events` 永远返回错误，
排障时拿不到 Events。

## 修法

`events.py` 里新增 `_timestamp_key()`，把 `None` 统一成 `0.0`，正常时间用 `datetime.timestamp()`，
排序不再混类型。其余逻辑不变。

镜像基于上游 0.1.12 镜像，只覆盖
`/usr/local/lib/python3.12/site-packages/mcp_kubernetes_server/events.py`，依赖不重装。

上游源码 commit：`e1184f8c7c010a09be8dcc89094fe7f6d67bd1b0`。

## 构建和替换

在能拉到上游镜像的机器上：

```sh
cd deploy/mcp-k8s-events-fix
docker build -t feiskyer-mcp-kubernetes-server:0.1.12-eventsfix .
```

改 `/opt/aiops/mcp-k8s-<集群名>/docker-compose.yml` 的 `image:` 为该 tag，
`docker-compose up -d` 重建容器。回滚改回原镜像 tag 再 `up -d` 即可。

同一镜像可复用到所有 k8s MCP 实例（cluster-a / prod）。

## 验证

- 镜像内 `grep -n _timestamp_key /usr/local/lib/python3.12/site-packages/mcp_kubernetes_server/events.py` 有命中。
- 用混合时间戳（`None` + `datetime`）的假事件直接调 `k8s_events(sort_by="lastTimestamp")`，不返回 `Error:`。
- 对任一集群只读调用 `k8s_events`（带 `namespace` 和 `sort_by`），返回事件列表。

上游修好后应改回官方镜像。修复本身也可提给上游。