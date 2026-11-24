# 写权限 K8s MCP 单集群部署

一个目录就是一个集群：MCP 容器 + nginx 认证容器。复制目录、改几个常量、`docker compose up -d`，不用 `.env`，不用脚本。

## 1. 复制并改常量

```sh
cp -r deploy/mcp-k8s-write /opt/aiops/mcp-k8s-cluster-a
cd /opt/aiops/mcp-k8s-cluster-a

mkdir -p kubeconfig
cp ~/.kube/cluster-a.yaml kubeconfig/cluster.yaml
chmod 600 kubeconfig/cluster.yaml
```

要改的地方：

| 位置 | 改什么 |
| --- | --- |
| `docker-compose.yml` 的 `user:` | `id -u`:`id -g`，必须能读 0600 的 kubeconfig |
| `docker-compose.yml` 的裸名 `mcp-k8s-cluster-a` | 2 处：服务定义和 `depends_on`，换成实际集群名 |
| `docker-compose.yml` 的 `mcp-k8s-cluster-a-auth` | 1 处：认证服务名，平台 URL 用这个名字 |
| `nginx.conf` 的 `proxy_pass` | 1 处：`http://mcp-k8s-cluster-a:8766` 换成实际集群名 |
| `nginx.conf` 的 Bearer token | `openssl rand -hex 32` 生成，平台 header 用同一个值 |

真实 token 只写在复制出去的那份里，不要改回仓库里的模板目录，避免把 token 提交进 git。

再启动：

```sh
docker compose up -d
docker compose ps
```

必须守住：

- 每个集群一份**独立** kubeconfig。工具启动时固定 current-context，共用一份完整 kubeconfig 只会连到同一个集群。
- 不要用集群管理员 kubeconfig，权限只给确实需要变更的 namespace。
- 同一个 `aiops-net` 上不能有两个同名服务，复制后一定要改服务名。
- 平台和这个 compose 在同一台 Docker 主机。

## 2. 验证

```sh
# 不带 token：预期 401
docker compose exec mcp-k8s-cluster-a-auth sh -c \
  'wget -S -O /dev/null http://127.0.0.1:8766/mcp' 2>&1 | grep -m1 'HTTP/'

# 带正确 token：预期不是 401
docker compose exec mcp-k8s-cluster-a-auth sh -c \
  'wget -S -O /dev/null --header="Authorization: Bearer CHANGE_ME" http://127.0.0.1:8766/mcp' \
  2>&1 | grep -m1 'HTTP/'
```

## 3. 加到平台

「能力 → MCP」新增（仅 admin 能改风险配置）：

- 名称：`k8s-cluster-a`
- system：`kubernetes`
- URL：`http://mcp-k8s-cluster-a-auth:8766/mcp`
- headers：`Authorization: Bearer <nginx.conf 里的 token>`
- `readOnly`：`true`
- `mutateTools`：

```text
k8s_create,k8s_expose,k8s_run,k8s_set_resources,k8s_set_image,k8s_set_env,k8s_rollout_undo,k8s_rollout_restart,k8s_rollout_pause,k8s_rollout_resume,k8s_scale,k8s_autoscale,k8s_cordon,k8s_uncordon,k8s_drain,k8s_taint,k8s_untaint,k8s_exec_command,k8s_port_forward,k8s_cp,k8s_apply,k8s_patch,k8s_label,k8s_annotate,k8s_delete,kubectl,helm
```

这样读工具（get/describe/logs/events/top/rollout 查询）自动执行，写工具必须审批。`mutateTools` 必须列全写工具：`readOnly: true` 下没列出来的工具会按只读放行。上游 MCP 工具集变化时，平台 health 会标“需复核”，确认后要补进这个列表。

不想维护列表就把 `readOnly` 设成 `false`：所有工具都走审批，包括排障读操作。

## 4. 再部署一个集群

重复第 1 步，换目录名、集群名、token、kubeconfig；平台里再加一条对应的 MCP。每个集群一个服务名、一个 token，互不影响。

## 5. 停止和升级

```sh
docker compose down
git -C <仓库> pull
# 如果镜像用了固定 tag，先 pull 再 up
docker compose pull
docker compose up -d
```

数据都在外部：kubeconfig 和 compose 目录本身，无本地卷。