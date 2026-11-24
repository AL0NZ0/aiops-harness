# 只读 K8s MCP 部署

一个目录就是一套：MCP 容器 + nginx 认证容器。复制目录、改几个常量、`docker compose up -d`，不用 `.env`，不用脚本。

## 1. 复制并改常量

```sh
cp -r deploy/mcp-k8s-read /opt/aiops/mcp-k8s-ro
cd /opt/aiops/mcp-k8s-ro

mkdir -p kubeconfig
cp ~/kube/aiops-ro.yaml kubeconfig/cluster.yaml
chmod 600 kubeconfig/cluster.yaml
```

要改的地方：

| 位置 | 改什么 |
| --- | --- |
| `docker-compose.yml` 的 `user:` | `id -u`:`id -g`，必须能读 0600 的 kubeconfig |
| `nginx.conf` 的 Bearer token | `openssl rand -hex 32` 生成，平台 header 用同一个值 |
| 服务名（可选） | 同时部署多套只读实例时，把 `mcp-k8s-read` 和 `mcp-k8s-read-auth` 改成不同名字 |

启动：

```sh
docker compose up -d
docker compose ps
```

## 2. 验证

```sh
# 不带 token：预期 401
docker compose exec mcp-k8s-read-auth sh -c \
  'wget -S -O /dev/null http://127.0.0.1:8765/mcp' 2>&1 | grep -m1 'HTTP/'

# 带正确 token：预期不是 401（GET /mcp 常见 400/405）
docker compose exec mcp-k8s-read-auth sh -c \
  'wget -S -O /dev/null --header="Authorization: Bearer <token>" http://127.0.0.1:8765/mcp' \
  2>&1 | grep -m1 'HTTP/'
```

## 3. 加到平台

「能力 → MCP」新增（仅 admin 能改风险配置）：

- 名称：`k8s`（多套只读实例时自己区分）
- system：`kubernetes`
- URL：`http://mcp-k8s-read-auth:8765/mcp`
- headers：`Authorization: Bearer <nginx.conf 里的 token>`
- `readOnly`：`true`
- `mutateTools`：`helm`

只读实例已经在 `command` 里加了 `--disable-write --disable-delete --disable-kubectl`，写工具根本不会暴露。平台 `readOnly: true` 下没列进 `mutateTools` 的工具按只读放行，所以上游新增危险工具时要复核补入（平台 health 会标「需复核」）。

## 4. 停止和升级

```sh
docker compose down
docker compose pull
docker compose up -d
```

kubeconfig 和 compose 目录是唯一的状态，没有本地卷。