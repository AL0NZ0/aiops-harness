# Docker Compose 手工部署手册

面向新环境、单机 Docker / Docker Compose，全程手工写配置，不使用安装脚本。概览见 [README.md](README.md)。旧数据迁移不走这份文档；迁移见第 8 节。

部署拓扑：

```text
浏览器 ──> 平台 :8787 ──aiops-net──> mcp-k8s-read-auth:8765 / mcp-vm-auth:8080 / mcp-es-auth:8080 ──> K8s / VM / ES
                    ├──> mcp-k8s-<集群>-auth:8766（写权限，可选）
                    └──> mysql:3306（只给平台容器）
```

- 每个 MCP 一个目录、一份独立 compose（MCP 容器 + nginx 认证），不用 `.env`。
- MCP 端口只在 `aiops-net` 内可达，不发布到宿主机。
- MySQL 只发布到宿主机 `127.0.0.1:3307`，给本机排查用。
- 平台和所有 MCP 必须在同一台 Docker 主机。

## 1. 前置检查

```sh
docker version --format '{{.Server.Version}}'
docker compose version
openssl version
id -u
id -g
```

要求：

- Docker 24+、Docker Compose v2。
- 能拉取 `ghcr.io`、`docker.elastic.co`；国内网络先配置镜像代理或镜像仓库。
- 用普通运维用户执行，不要用 root。平台容器会以当前用户的 UID/GID 运行，`data/` 才不会出现读不了的 0600 文件。
- 准备只读 K8s 的 kubeconfig，建议单独做最小权限账号，不要直接给集群管理员。
- 准备 VictoriaMetrics 地址、Elasticsearch 地址和账号。
- 生产环境把各 MCP 目录里的 `image` 改成固定 tag 或 digest，不要长期用 `latest`。

```sh
git clone <仓库地址> aiops-harness
cd aiops-harness
```

## 2. 创建共享网络

```sh
docker network inspect aiops-net >/dev/null 2>&1 || docker network create aiops-net
```

平台和所有 MCP 目录都使用这个 external 网络。没有它，`docker compose up` 会直接报错。

## 3. 手工部署 MCP

每个 MCP 一个目录、一份独立 compose：MCP 容器 + nginx 认证容器。不用 `.env`，常量直接写在文件里；复制目录就是再部署一套。按需部署第 3.2–3.4 节，写权限集群见 3.6。

所有 MCP 都不发布宿主机端口，平台通过 `aiops-net` 的服务名访问。

### 3.1 准备

K8s：准备只读 kubeconfig，建议单独做最小权限账号，不要用集群管理员。

```sh
ls -l ~/kube/aiops-ro.yaml
test -r ~/kube/aiops-ro.yaml && echo readable
```

文件保持 `0600` 即可，MCP 容器用宿主机 UID/GID 运行（compose 里的 `user:`）。

VM / ES：确认数据源地址和账号。数据源跑在宿主机时 URL 可用 `host.docker.internal`；但数据源只监听 `127.0.0.1` 时容器连不上，需要监听 `0.0.0.0` / 内网地址，或把数据源接进 `aiops-net`。

Token 每个 MCP 一个，只允许字母、数字和 `._~+/=-`：

```sh
openssl rand -hex 32
```

不要复用 token，也不要把 token 贴到工单或聊天里。真实 token 只写进复制出去的目录，不要改仓库模板。

### 3.2 只读 K8s

```sh
cp -r deploy/mcp-k8s-read /opt/aiops/mcp-k8s-ro
cd /opt/aiops/mcp-k8s-ro

mkdir -p kubeconfig
cp ~/kube/aiops-ro.yaml kubeconfig/cluster.yaml
chmod 600 kubeconfig/cluster.yaml
```

改两处：

- `docker-compose.yml` 的 `user:` 改成 `id -u`:`id -g`，否则读不了 0600 的 kubeconfig。
- `nginx.conf` 的 Bearer token 改成上面生成的值。

同时部署多套只读实例时，再把 `mcp-k8s-read` / `mcp-k8s-read-auth` 改成不同名字（compose 和 nginx.conf 同步）。

```sh
docker compose up -d
docker compose ps
```

只读实例的 `command` 已带 `--disable-write --disable-delete --disable-kubectl`。

### 3.3 VictoriaMetrics

```sh
cp -r deploy/mcp-vm /opt/aiops/mcp-vm
cd /opt/aiops/mcp-vm
```

- `docker-compose.yml` 的 `VM_INSTANCE_ENTRYPOINT` 改成实际地址，如 `http://10.0.0.20:8428`。
- `nginx.conf` 的 Bearer token 改成生成的值。

```sh
docker compose up -d
docker compose ps
```

### 3.4 Elasticsearch

```sh
cp -r deploy/mcp-es /opt/aiops/mcp-es
cd /opt/aiops/mcp-es
chmod 600 docker-compose.yml
```

- `docker-compose.yml` 的 `ES_URL`、`ES_USERNAME`、`ES_PASSWORD` 改成实际值，账号只给读索引的权限。
- `nginx.conf` 的 Bearer token 改成生成的值。

```sh
docker compose up -d
docker compose ps
```

ES 密码在 compose 文件里是明文（不用 `.env` 的代价），只留在复制出去的那份，别提交回仓库。

### 3.5 验证认证

在每个 MCP 目录里执行。不带 token 必须 401，带正确 token 不能是 401（GET 常见 400/405 也算通过认证）：

```sh
# 只读 K8s
docker compose exec mcp-k8s-read-auth sh -c \
  'wget -S -O /dev/null http://127.0.0.1:8765/mcp' 2>&1 | grep -m1 'HTTP/'
docker compose exec mcp-k8s-read-auth sh -c \
  'wget -S -O /dev/null --header="Authorization: Bearer <token>" http://127.0.0.1:8765/mcp' \
  2>&1 | grep -m1 'HTTP/'
```

VM 和 ES 分别换成 `mcp-vm-auth` / `mcp-es-auth`、端口 `8080` 和各自 token。带错 token 必须是 401。

### 3.6 可选：写权限 K8s（多集群）

写权限实例每个集群一个 MCP 容器 + 一个 nginx 认证容器，不发布宿主机端口，平台通过 `aiops-net` 的服务名访问。

仓库里有现成模板 `deploy/mcp-k8s-write/`，复制一份就是一个集群：

```sh
cp -r deploy/mcp-k8s-write /opt/aiops/mcp-k8s-cluster-a
cd /opt/aiops/mcp-k8s-cluster-a

mkdir -p kubeconfig
cp ~/kube/cluster-a-rw.yaml kubeconfig/cluster.yaml
chmod 600 kubeconfig/cluster.yaml
```

然后改这几处：

- `docker-compose.yml` 的 `user:` 改成 `id -u`:`id -g`，否则读不了 0600 的 kubeconfig。
- `docker-compose.yml` 里两处 `mcp-k8s-cluster-a`、一处 `mcp-k8s-cluster-a-auth` 换成实际集群名；`nginx.conf` 的 `proxy_pass` 同步改。
- `nginx.conf` 的 Bearer token 改成 `openssl rand -hex 32` 生成的值。

启动和验证：

```sh
docker compose up -d
docker compose ps

# 不带 token：预期 401
docker compose exec mcp-k8s-cluster-a-auth sh -c \
  'wget -S -O /dev/null http://127.0.0.1:8766/mcp' 2>&1 | grep -m1 'HTTP/'
# 带正确 token：预期不是 401
docker compose exec mcp-k8s-cluster-a-auth sh -c \
  'wget -S -O /dev/null --header="Authorization: Bearer <token>" http://127.0.0.1:8766/mcp' \
  2>&1 | grep -m1 'HTTP/'
```

必须确认：

- 每个集群一份**独立** kubeconfig。工具启动时固定 current-context，共用一份完整 kubeconfig 只会连到同一个集群。
- 不要用集群管理员 kubeconfig。
- 同一个 `aiops-net` 上不能有两个同名服务，复制后一定要改服务名。
- 写实例不传 `--disable-*`；只读实例就在 `command` 里加 `--disable-write --disable-delete --disable-kubectl`。

平台侧在「能力 → MCP」新增（仅 admin 能改风险配置）：

- 名称 `k8s-cluster-a`，system `kubernetes`
- URL `http://mcp-k8s-cluster-a-auth:8766/mcp`
- headers：`Authorization: Bearer <同一个 token>`
- `readOnly: true`
- `mutateTools`：

```text
k8s_create,k8s_expose,k8s_run,k8s_set_resources,k8s_set_image,k8s_set_env,k8s_rollout_undo,k8s_rollout_restart,k8s_rollout_pause,k8s_rollout_resume,k8s_scale,k8s_autoscale,k8s_cordon,k8s_uncordon,k8s_drain,k8s_taint,k8s_untaint,k8s_exec_command,k8s_port_forward,k8s_cp,k8s_apply,k8s_patch,k8s_label,k8s_annotate,k8s_delete,kubectl,helm
```

这样读工具自动执行、写工具必须审批。`mutateTools` 必须列全：`readOnly: true` 下没列出来的工具会按只读放行；上游工具集变化时平台 health 会标“需复核”，确认后要补进列表。不想维护列表就把 `readOnly` 设成 `false`，所有工具都走审批。

再部署一个集群就再复制一份目录，换集群名、token、kubeconfig，平台再加一条 MCP。详细说明见 [mcp-k8s-write/README.md](mcp-k8s-write/README.md)。

## 4. 手工部署平台

回到仓库根目录：

```sh
cd ../..
```

### 4.1 生成并写根 `.env`

先生成数据库和管理员密码：

```sh
umask 077
MYSQL_ROOT_PASSWORD=$(openssl rand -hex 32)
MYSQL_PASSWORD=$(openssl rand -hex 32)
ADMIN_PASSWORD=$(openssl rand -hex 24)
INTERNAL_TOKEN=$(openssl rand -hex 32)
METRICS_TOKEN=$(openssl rand -hex 32)
```

写根 `.env`：

```sh
cat > .env <<EOF
MYSQL_ROOT_PASSWORD='$MYSQL_ROOT_PASSWORD'
MYSQL_DATABASE='aiops'
MYSQL_USER='aiops'
MYSQL_PASSWORD='$MYSQL_PASSWORD'
MYSQL_PORT='3307'

AIOPS_UID='$(id -u)'
AIOPS_GID='$(id -g)'

AIOPS_DB_HOST='127.0.0.1'
AIOPS_DB_PORT='3307'
AIOPS_DB_USER='aiops'
AIOPS_DB_PASSWORD='$MYSQL_PASSWORD'
AIOPS_DB_NAME='aiops'
AIOPS_DB_CONNECT_TIMEOUT_MS='60000'

AIOPS_AUTH='local'
AIOPS_ADMIN_USERNAME='admin'
AIOPS_ADMIN_PASSWORD='$ADMIN_PASSWORD'
AIOPS_INTERNAL_TOKEN='$INTERNAL_TOKEN'

AIOPS_PUBLIC_URL='http://10.0.0.10:8787'
AIOPS_BIND_ADDR='0.0.0.0'
AIOPS_HTTP_PORT='8787'
AIOPS_COOKIE_SECURE='0'

AIOPS_METRICS_TOKEN='$METRICS_TOKEN'
AIOPS_VERSION='manual-$(date +%Y%m%d-%H%M%S)'
EOF
chmod 600 .env
unset MYSQL_ROOT_PASSWORD MYSQL_PASSWORD ADMIN_PASSWORD INTERNAL_TOKEN METRICS_TOKEN
```

必须检查：

- `AIOPS_PUBLIC_URL` 改成浏览器实际访问地址。审批深链和告警回调都用它。
- 只给本机用：`AIOPS_BIND_ADDR='127.0.0.1'`；局域网访问用 `0.0.0.0`。
- 内网 HTTP 保持 `AIOPS_COOKIE_SECURE='0'`。HTTPS 由反向代理终结时才改为 `1`，并设置 `AIOPS_TRUST_PROXY='1'`，同时保证平台端口只能经反代访问。
- `MYSQL_PASSWORD` 和 `AIOPS_DB_PASSWORD` 必须相同。
- `AIOPS_UID` / `AIOPS_GID` 用 `id -u` / `id -g` 的实际值。
- 不要把 `AIOPS_ADMIN_PASSWORD` 写进 `config/` 或提交到 git。它只在空库 bootstrap 时生效。
- 如使用外部加密密钥，在 `.env` 增加 `AIOPS_SECRET_KEY='...'`；不设置则首次启动自动生成 `data/secret.key`。二选一，不要混用两套不一致的 key。

### 4.2 初始化 `data/`

```sh
mkdir -p data
chmod 700 data
```

先写一个空的 MCP 列表，MCP 条目在首次登录后用页面添加，token 由平台加密落盘，不需要环境变量：

```sh
printf '{"servers":[]}\n' > data/mcp-servers.json
chmod 600 data/mcp-servers.json
```

平台启动后不要在运行时手改这个文件；MCP 存储会加密 header 并回写。之后一律用「能力 → MCP」页面改。

### 4.3 校验并启动

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

首次构建需要拉 Node、MySQL 镜像并编译 TypeScript。等 MySQL healthy、平台 Up。

### 4.4 验证

```sh
curl -sS http://127.0.0.1:8787/health
curl -sS http://127.0.0.1:8787/ready
```

`/health` 只检查进程；`/ready` 检查 MySQL。两者都正常后再打开 `AIOPS_PUBLIC_URL`。

检查 `/metrics` 的 token：

```sh
TOKEN=$(grep '^AIOPS_METRICS_TOKEN=' .env | cut -d= -f2- | tr -d "'\"")
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8787/metrics | head
unset TOKEN
```

管理员用户名和初始密码在根 `.env` 的 `AIOPS_ADMIN_USERNAME` / `AIOPS_ADMIN_PASSWORD`。用编辑器打开查看，不要 `cat` 到共享终端；首次登录会强制改密。

登录后到「能力 → MCP」逐条添加已部署的 MCP，headers 填 `Authorization: Bearer <该目录 nginx.conf 里的 token>`：

| 名称 | system | URL | readOnly | mutateTools |
| --- | --- | --- | --- | --- |
| `k8s` | `kubernetes` | `http://mcp-k8s-read-auth:8765/mcp` | `true` | `helm` |
| `vm` | `prometheus` | `http://mcp-vm-auth:8080/mcp` | `true` | 空 |
| `es` | `elasticsearch` | `http://mcp-es-auth:8080/mcp` | `true` | 空 |
| `k8s-<集群>` | `kubernetes` | `http://mcp-k8s-<集群>-auth:8766/mcp` | `true` | 完整写工具列表，见 3.6 |

保存时平台会在线探测，MCP 没起来会返回 502，先确认对应目录 `docker compose ps` 正常。

添加后确认：

- 每条 MCP 显示健康。
- 需要复核的工具会显示「需复核」；确认工具集变化后再点确认。
- 告警任务只允许只读工具；不要在 `mutateTools` 之外留下被默认当成只读的写工具。

### 4.5 首次登录后

- 立即修改管理员密码。初始密码只对空库生效，后续改密码在页面里做。
- 在「能力 → 模型」配置至少一个 OpenAI 兼容 provider，并设为启用。网页任务和告警排查需要模型；没有 provider 时告警任务直接失败，不会回退 playbook。
- 如果 DSH 远程接 `/mcp`，在账号页创建 `tools:execute` 的 API key；token 只回显一次。
- 通知渠道和告警接入按 `docs/使用手册.md` 配置。告警 webhook 地址是 `AIOPS_PUBLIC_URL` + `/api/hooks/alerts/<sourceId>`，token 也只回显一次。

## 5. 部署顺序

推荐先 MCP、后平台：平台添加 MCP 时会在线探测，MCP 没起来保存直接 502。

平台先部署也可以：先启动平台，再部署 MCP 目录，然后在「能力 → MCP」添加条目；健康巡检发现上游恢复后自动变健康。

平台里存的 token 必须和对应目录 `nginx.conf` 的一致，否则一直 401。平台不回显已存 token，不确定时干脆重新生成：先改 `nginx.conf` 并 `docker compose up -d`，再到页面编辑该 MCP 粘贴同一个值保存。

## 6. 常见问题

**MCP 一直 401**：平台里填的 token 和该目录 `nginx.conf` 不一致，或请求没带 `Authorization: Bearer`。见第 5 节重新对齐。

**K8s MCP 报 kubeconfig 权限错误**：compose 的 `user:` 和 kubeconfig 属主不一致，或执行部署的用户本身读不了文件。用 `ls -ln` 看 UID/GID，保持 `0600`，不要用 `chmod 644` 图省事。

**MCP 健康但工具调用失败**：健康巡检只做 `initialize` + `tools/list`，不调用工具。看 `docker compose logs` 和平台任务事件里的工具错误；检查上游账号、网络和工具参数。

**ES MCP 工具报 `terminated` 或等待很久才失败**：上游把 nginx 透传的 `Authorization: Bearer <平台 token>` 当成 ES 的 API key 发给了集群，返回 401。`deploy/mcp-es/nginx.conf` 里必须是 `proxy_set_header Authorization "";`，让上游改用 `ES_USERNAME` / `ES_PASSWORD`。改完 `docker-compose restart es-auth`，用带 token 的 `tools/call` 验证能返回数据且连接立即结束。

平台客户端现在增量读取 SSE：拿到匹配 id 的响应就断开，非 2xx 也只读一小段错误体就返回，不再等满 `timeoutMs`。所以真遇到 `terminated` 是上游直接断连（查代理、证书、超时）；等满 `timeoutMs` 报「等待响应超过」则是上游一直没有返回匹配的响应。

**平台连不上 MySQL**：容器内应走 `mysql:3306`，根 `.env` 的 `127.0.0.1:3307` 只给宿主机开发用。确认 `docker compose ps` 里 MySQL healthy，以及 `MYSQL_PASSWORD` 和 `AIOPS_DB_PASSWORD` 一致。已有 MySQL volume 时，改 `.env` 密码不会改库里的密码。

**数据目录读不了**：`ls -ln data` 看属主，`AIOPS_UID` / `AIOPS_GID` 必须是实际用户；不要用 root 部署后再切普通用户。

**端口被占用**：改 `AIOPS_HTTP_PORT` / `MYSQL_PORT` 后 `docker compose up -d`。MCP 不占宿主机端口，容器之间端口相同也不冲突。

**镜像没更新**：`latest` 叠加本地缓存会看起来“升级没生效”。用固定 tag/digest；升级时 `docker compose pull` 或 `docker compose build --pull`。

**平台启动即退出，日志是 `AuthError: 密码至少 12 个字符`**：`AIOPS_ADMIN_PASSWORD` 不足 12 位，空库 bootstrap 建管理员时校验失败，进程直接退出。改 `.env` 后 `docker compose up -d --force-recreate aiops`。失败时用户表没有写入，改对密码重启会重新建号；建出来的管理员默认 `mustChangePassword`，首次登录必须改密。

**局域网访问 `http://<ip>:8787` 不通**：compose 默认把 8787 绑在 `127.0.0.1`。`ss -lntp | grep 8787` 只看到回环就说明没开；在 `.env` 设 `AIOPS_BIND_ADDR='0.0.0.0'`，再 `docker compose up -d --force-recreate aiops`（改端口映射必须重建容器）。开给内网前确认 `AIOPS_AUTH='local'`。

**构建时报 `npm error Exit handler never called!` 或大量 `ETIMEDOUT`**：不是 npm 的问题，是构建容器没有出网。`/etc/docker/daemon.json` 里 `"iptables": false` 的节点（CCE 常见）不会给容器做 SNAT。临时用 `docker build --network=host ...`；长期在节点上补 MASQUERADE 并用 systemd 持久化：

```sh
iptables -t nat -A POSTROUTING -s 172.17.0.0/16 -j MASQUERADE   # 默认 bridge
iptables -t nat -A POSTROUTING -s 169.254.30.0/28 -j MASQUERADE # 有 bip 时
```

写进 `Type=oneshot`、`RemainAfterExit=yes` 的 systemd 单元并 `systemctl enable --now`，否则节点重启后规则丢失。网段按本机 `docker network inspect` 的结果调整。

**提示 `docker: 'compose' is not a docker command`**：有些环境只装了独立二进制 `docker-compose`，功能相同。用 `docker-compose ...`，或者安装 compose 插件后使用 `docker compose ...`。

## 7. 升级、停止和备份

平台升级：

```sh
git pull
docker compose up -d --build
```

MCP 升级：在每个 MCP 目录分别执行（只读 K8s、VM、ES、各写权限集群）。

```sh
cd /opt/aiops/mcp-k8s-ro
docker compose pull
docker compose up -d
```

停止但保留数据：

```sh
docker compose down
cd /opt/aiops/mcp-k8s-ro && docker compose down   # 每个 MCP 目录分别停
```

MCP 目录没有本地卷，kubeconfig 和 `nginx.conf` 就在目录里，不需要备份到别处。

**不要执行 `docker compose down -v`**，除非确认要删除 MySQL 数据。

备份见 `deploy/backup.sh` 和 `docs/使用手册.md`。必须同时备份 MySQL volume 和 `./data/`；只备一个恢复不出完整状态。`data/secret.key` 和备份口令丢失后，加密凭证无法恢复。

## 8. 旧环境迁移

这份手册只讲新部署。迁移旧环境时额外注意：

- 不要重新生成 `AIOPS_SECRET_KEY`。要么继续使用旧 `data/secret.key`，要么把旧 key 注入环境变量，两边必须一致。
- 恢复旧 MySQL 数据后，根 `.env` 里的 `AIOPS_ADMIN_PASSWORD` 不会重置已有管理员密码。
- `data/` 和 MySQL 必须成对迁移。
- 迁移前先在非生产演练恢复，确认 `enc:v1:` 字段能解密。

更完整的备份/恢复命令见 `deploy/README.md`、`deploy/restore.sh` 和 `docs/使用手册.md`。