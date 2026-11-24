# Docker Compose 部署

全部手工配置，没有安装脚本。一台 Docker 主机上：平台 + MySQL 一份 compose，每个 MCP 一个目录、一份独立 compose（MCP 容器 + nginx 认证）。加一个 MCP 或一个集群就是复制目录改常量。

| 目录 / 文件 | 作用 | 网络 |
| --- | --- | --- |
| 根 `docker-compose.yml` + `.env` | 平台 + MySQL，宿主机发布 `8787` | `aiops-net` |
| `deploy/mcp-k8s-read/` | 只读 K8s MCP + nginx 认证 | `aiops-net`，不发布宿主机端口 |
| `deploy/mcp-vm/` | VictoriaMetrics MCP + nginx 认证 | 同上 |
| `deploy/mcp-es/` | Elasticsearch MCP + nginx 认证 | 同上 |
| `deploy/mcp-k8s-write/` | 写权限 K8s 单集群模板，复制多份就是多集群 | 同上 |

```text
浏览器 ──> 平台 :8787 ──aiops-net──> mcp-k8s-read-auth:8765 ──> K8s(只读)
                    ├──aiops-net──> mcp-vm-auth:8080 ──> VictoriaMetrics
                    ├──aiops-net──> mcp-es-auth:8080 ──> Elasticsearch
                    ├──aiops-net──> mcp-k8s-<集群>-auth:8766 ──> K8s(可写)
                    └──> mysql:3306（只给平台容器）
```

## 最短流程

```sh
git clone <仓库地址> aiops-harness
cd aiops-harness
docker network create aiops-net   # 已存在会报错，忽略即可
```

1. 部署需要的 MCP。每个目录都按同样方式：复制、改常量、启动。例如只读 K8s：

   ```sh
   cp -r deploy/mcp-k8s-read /opt/aiops/mcp-k8s-ro
   cd /opt/aiops/mcp-k8s-ro
   # 按该目录的 README.md 改 user、kubeconfig、nginx.conf token
   docker compose up -d
   ```

   `deploy/mcp-vm/`、`deploy/mcp-es/`、`deploy/mcp-k8s-write/` 同理，各自目录里有 README。

2. 平台：按 [MANUAL 第 4 节](MANUAL.md#4-手工部署平台) 写根 `.env`，然后：

   ```sh
   docker compose up -d --build
   ```

3. 登录后到「能力 → MCP」逐条添加，token 直接粘贴进页面（平台加密落盘，不需要环境变量）：

   | 名称 | system | URL | 风险 |
   | --- | --- | --- | --- |
   | `k8s` | `kubernetes` | `http://mcp-k8s-read-auth:8765/mcp` | `readOnly: true`，`mutateTools: helm` |
   | `vm` | `prometheus` | `http://mcp-vm-auth:8080/mcp` | `readOnly: true` |
   | `es` | `elasticsearch` | `http://mcp-es-auth:8080/mcp` | `readOnly: true` |
   | `k8s-cluster-a` | `kubernetes` | `http://mcp-k8s-cluster-a-auth:8766/mcp` | `readOnly: true` + 完整 `mutateTools` |

   每条都加 header：`Authorization: Bearer <对应 nginx.conf 里的 token>`。

登录信息在根 `.env` 的 `AIOPS_ADMIN_USERNAME` / `AIOPS_ADMIN_PASSWORD`，首次登录强制改密。

## 每个 MCP 目录

都是「MCP 容器 + nginx 认证容器」两件套，常量直接写在文件里，不用 `.env`、不用脚本。复制目录后改这几类东西：

- `docker-compose.yml` 的 `user:`（K8s）、数据源地址/账号（VM、ES）。
- `docker-compose.yml` 和 `nginx.conf` 里的服务名（同时部署多套时）。
- `nginx.conf` 的 Bearer token，`openssl rand -hex 32` 生成。

真实地址、密码和 token 只写在复制出去的那份，不要改回仓库模板。ES 的密码在 compose 文件里是明文，记得 `chmod 600 docker-compose.yml`。

写权限 K8s 的完整说明（`mutateTools` 列表、独立 kubeconfig、多集群）见 [mcp-k8s-write/README.md](mcp-k8s-write/README.md)。

## 验证

```sh
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/ready

# 各 MCP 目录里
docker compose ps
docker compose exec <认证容器名> sh -c 'wget -S -O /dev/null http://127.0.0.1:<端口>/mcp' 2>&1 | grep -m1 'HTTP/'
```

不带 token 必须 401。平台启动后会在「能力 → MCP」做健康巡检；MCP 没起来只记录 `mcpErrors`，不影响平台启动。

## 网络和安全边界

- 所有 MCP 都只在 `aiops-net` 内可达，不发布宿主机端口；平台按服务名访问。
- 每个 MCP 一个独立 Bearer token，nginx 只校验 header，不把 token 写进日志。
- 只读 K8s 固定 `--disable-write --disable-delete --disable-kubectl`；写权限实例单独部署，平台仍强制审批。
- 平台默认内网 HTTP。登录密码、API key、告警 Token 在局域网内明文传输，只适合可信网段；跨不可信网络时在前面加 TLS 反向代理。
- HTTPS 由反代终结时，`AIOPS_PUBLIC_URL` 用 `https://...`，并设置 `AIOPS_COOKIE_SECURE=1`、`AIOPS_TRUST_PROXY=1`，保证平台端口只能从反代访问。
- 告警排查会把日志、`describe` 和指标输出发给模型 provider；上线前确认数据合规和外发策略。

## 升级和停止

```sh
# 平台
git pull
docker compose up -d --build

# 每个 MCP 目录（各目录分别执行）
docker compose pull && docker compose up -d
```

停止但保留数据：

```sh
docker compose down
cd /opt/aiops/mcp-k8s-ro && docker compose down   # 各 MCP 目录分别停
```

**不要执行 `docker compose down -v`**，除非确认要删除 MySQL 数据。

数据位置：MySQL 在 Docker volume；平台在 `./data/`（含 `secret.key`）；平台配置在根 `.env`（0600）；MCP 的数据源地址和 token 在各个 MCP 目录里。`data/secret.key` 和备份口令丢失后，加密数据无法恢复。