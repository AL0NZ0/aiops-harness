# VictoriaMetrics MCP 部署

一个目录就是一套：MCP 容器 + nginx 认证容器。复制目录、改数据源地址和 token，`docker compose up -d`，不用 `.env`。

## 1. 复制并改常量

```sh
cp -r deploy/mcp-vm /opt/aiops/mcp-vm
cd /opt/aiops/mcp-vm
```

要改的地方：

| 位置 | 改什么 |
| --- | --- |
| `docker-compose.yml` 的 `VM_INSTANCE_ENTRYPOINT` | 数据源地址，如 `http://10.0.0.20:8428`；跑在宿主机时可用 `http://host.docker.internal:8428` |
| `docker-compose.yml` 的 `VM_INSTANCE_TYPE` | single 实例保持 `single`，集群版按 VictoriaMetrics 文档填 |
| `nginx.conf` 的 Bearer token | `openssl rand -hex 32` 生成，平台 header 用同一个值 |
| 服务名（可选） | 同时部署多套时改 `mcp-vm` / `mcp-vm-auth` |

数据源只监听 `127.0.0.1` 时容器连不上：改成监听 `0.0.0.0` 或内网地址，或把 VictoriaMetrics 接进 `aiops-net`。

启动：

```sh
docker compose up -d
docker compose ps
```

## 2. 验证

```sh
# 不带 token：预期 401
docker compose exec mcp-vm-auth sh -c \
  'wget -S -O /dev/null http://127.0.0.1:8080/health/liveness' 2>&1 | grep -m1 'HTTP/'
# 带正确 token：预期不是 401
docker compose exec mcp-vm-auth sh -c \
  'wget -S -O /dev/null --header="Authorization: Bearer <token>" http://127.0.0.1:8080/health/liveness' \
  2>&1 | grep -m1 'HTTP/'
```

## 3. 加到平台

「能力 → MCP」新增：

- 名称：`vm`
- system：`prometheus`
- URL：`http://mcp-vm-auth:8080/mcp`
- headers：`Authorization: Bearer <nginx.conf 里的 token>`
- `readOnly`：`true`，`mutateTools` 留空

VictoriaMetrics MCP 只提供查询工具，没有写能力。

## 4. 停止和升级

```sh
docker compose down
docker compose pull
docker compose up -d
```