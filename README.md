# AIOps Harness

AIOps Harness 面向运维场景的轻量 AIOps 扩展层。它不 fork、不重写 DeepSeek Harness（DSH）或任何 Agent 引擎，也不把业务状态塞进引擎目录；DSH 负责推理、工具调用和会话，本仓库补上知识库、上游 MCP 接入、任务 API、变更审批、审计、资产/SSH 凭证和 Web 控制台。

> 当前版本 `0.1.0`，默认单实例部署，主要用于本机、团队内网和 K8s 单副本。审批结果、登录限速和后台清理已支持多实例共享 MySQL，但任务 runner 和 `/mcp` 会话不跨实例。真实生产写操作需要额外接入具备最小权限的 MCP server，并经过人工审批。

## 核心能力

- **任务与过程留痕**：网页、`POST /api/tasks` 和 `/api/v1` 建任务；每次工具调用、模型轮次、审批和最终结论都有事件与审计。
- **只读放行、变更审批**：所有工具只能经过 ToolBroker。只读工具自动执行；`risk: mutate` 必须先创建审批，审批人不能批准自己名下的变更，一个审批只能消费一次。
- **两种任务执行器**：配置 OpenAI 兼容 provider 后，网页/`POST /api/tasks` 由平台自己的有限步模型循环执行；没有模型配置时退回 Skill `playbook.json` 的知识检索。外部 DSH/WorkBuddy 任务由调用方自己推理和执行，平台只提供任务、工具、审批 API。
- **上游 MCP 统一接入**：K8s、VictoriaMetrics、Elasticsearch 等外部系统都通过 Streamable HTTP MCP 接入，工具注册为 `mcp.<server>.<tool>`；支持可选 `Authorization` 等 header 和 `${ENV_NAME}` 环境变量占位，token 加密落盘、接口不回显。
- **MCP 健康巡检**：启动后立即探测，默认每 30 秒执行 `initialize` + `tools/list`；连续失败 3 次摘除该 server 的工具，恢复后自动注册。上游工具集变化时要求人工复核风险分类。
- **账号与审计**：`AIOPS_AUTH=local` 时提供 scrypt 密码、MySQL 用户/会话/API key、HttpOnly Cookie + CSRF、角色 `viewer/operator/approver/auditor/admin`、登录限速和安全事件；不启用账号时保留本机 `x-actor-id` 自报头模式。
- **敏感数据保护**：`data/` 下的资产、凭证、MCP headers、模型 provider key、通知 webhook URL/钉钉加签密钥用 AES-256-GCM（`enc:v1:`）加密；API、页面、事件、日志和审计不返回明文。
- **SSH 高风险能力**：`ssh.test` 只读、`ssh.exec` 必须审批；资产绑定独立凭证，密码和私钥互斥，强制 SSH host key 指纹校验，指纹只能由管理员信任；支持最多 4 层跳板机（direct-tcpip）和 known_hosts 导入（默认预检、不覆盖已信任指纹）。
- **模型调用增强**：provider 默认 SSE 流式输出，网页能看到节流后的实时增量；429/5xx/超时按指数退避重试；累计 token 用量并按配置单价估算成本。
- **通用限流**：API/MCP 按客户端 IP、写请求按账号、登录按 IP 分别限流，超限 429 + `Retry-After`，进程内计数；多副本需要前置网关做全局配额。
- **部署与备份**：多阶段 Docker 镜像、非 root + 只读根文件系统、Docker Compose、K8s 简化清单、加密备份/恢复脚本和 K8s CronJob。
- **告警接入**：夜莺 v6（单规则回调/全局 Webhook）和 Alertmanager 推告警到 `/api/hooks/alerts/<sourceId>`，平台按严重级别阈值自动发起**只读**排查（不暴露变更工具、不产生审批），结果回推指定通知渠道或留在平台任务页；接入源 Token 只存 SHA-256。
- **可观测性**：`/health`、`/ready`、Prometheus `/metrics`、JSON 日志、安全事件和可选通知（钉钉/企业微信/通用 webhook）。

## 架构

```text
DSH / WorkBuddy / 浏览器 / 外部脚本
        │  MCP stdio、MCP Streamable HTTP、REST
        ▼
┌──────────────────────────────────────────────┐
│ AIOps Harness                            │
│  HTTP / Web 控制台                            │
│  任务 · 审批 · 审计 · 账号 · 通知 · 指标       │
│  ToolBroker：只读放行 / mutate 强制审批        │
│  知识库 · Skill · 平台模型循环                 │
└───────┬───────────────┬──────────────────────┘
        │               │
        ▼               ▼
   MySQL 8.4        data/（0600，加密字段）
   任务/审计/用户    资产/凭证/MCP/知识/密钥
        │
        ▼
  上游 MCP server（K8s / VictoriaMetrics / ES / ...）
```

`harness/` 只放接入说明，永远不放 DSH 源码。平台不绕过 DSH 的 MCP client，也不在扩展层实现第二套 Agent 框架。

## 快速开始（Docker）

前置条件：Docker 24+、Docker Compose v2；如果从源码开发，另需 Node.js >= 22。

```sh
git clone <仓库地址> aiops-harness && cd aiops-harness
docker network create aiops-net   # 已存在会报错，忽略即可

# 1. MCP：把需要的目录复制出去，改常量后各自启动
#    cp -r deploy/mcp-k8s-read /opt/aiops/mcp-k8s-ro && cd /opt/aiops/mcp-k8s-ro && docker compose up -d

# 2. 平台：复制 .env.example 为 .env 并填值，再启动
cp .env.example .env && chmod 600 .env
docker compose up -d --build
curl http://127.0.0.1:8787/ready
```

完整的逐文件手工步骤见 [手工部署手册](deploy/MANUAL.md)，部署概览和安全边界见 [Docker Compose 部署](deploy/README.md)。MCP 都是独立目录：`deploy/mcp-k8s-read`、`deploy/mcp-vm`、`deploy/mcp-es`、`deploy/mcp-k8s-write`，复制改常量即可，不用 `.env`、不用脚本；平台登录后在「能力 → MCP」添加条目。

`.env` 里几个必改项：

- `MYSQL_ROOT_PASSWORD`、`MYSQL_PASSWORD`：改成随机强密码。
- `AIOPS_UID` / `AIOPS_GID`：填宿主机当前用户，用 `id -u`、`id -g` 获取。`data/` 是绑定挂载，容器用户必须和宿主机属主一致，否则读不了 0600 文件。
- `AIOPS_ADMIN_USERNAME` / `AIOPS_ADMIN_PASSWORD`：空库首次启动时创建管理员；登录后立即改密，并从 `.env` 移除初始密码。
- `AIOPS_PUBLIC_URL`：审批通知深链和告警回调的基地址。本机用默认值；反向代理或域名访问时改成外部可访问地址。

启动完成后：

```sh
docker compose ps
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/ready
```

`/health` 只表示进程活着，`/ready` 会检查 MySQL。浏览器打开 <http://127.0.0.1:8787> 登录控制台。

数据位置：

- MySQL 数据：Docker named volume `aiops-mysql-data`（生产建议配好备份）。
- 平台运行数据：宿主机 `./data/`，包括资产、凭证、MCP 配置、通知、知识文档、模型 provider 和 `data/secret.key`。
- `config/*.json` 只在对应 `data/*.json` 不存在时作为种子；已有数据不会被启动覆盖。

停止服务但保留数据：

```sh
docker compose down          # 保留 named volume 和 ./data
# docker compose down -v     # 连 MySQL volume 一起删除，谨慎
```

## 本地开发

```sh
npm install
docker compose up -d mysql
npm test
npm run typecheck
node --check web/app.js
npm start
```

`npm start` 只作为开发兜底，读 `.env` 的 `AIOPS_DB_*` 连本机 `127.0.0.1:3307`。日常运行和部署统一用 Docker：

```sh
docker compose up -d --build aiops
```

构建与生产启动：

```sh
npm run build
npm run start:prod
```

## 配置项

完整变量和默认值见 `.env.example`、`docs/使用手册.md`。常用分组：

| 分组 | 变量 | 说明 |
| --- | --- | --- |
| 数据库 | `AIOPS_DB_HOST` / `PORT` / `USER` / `PASSWORD` / `NAME` | 平台必须能连 MySQL；Compose 内会覆盖成 `mysql:3306` |
| 容器 | `AIOPS_UID` / `AIOPS_GID` | 必须与宿主机 `data/` 属主一致 |
| 账号 | `AIOPS_AUTH=local` | 启用本地账号、API key 和权限；不设置则是 header 模式 |
| 管理员 | `AIOPS_ADMIN_USERNAME` / `AIOPS_ADMIN_PASSWORD` | 空库 bootstrap，仅首次启动需要 |
| 加密 | `AIOPS_SECRET_KEY` 或 `data/secret.key` | 丢失后已加密凭证无法恢复 |
| 外部地址 | `AIOPS_PUBLIC_URL` | 审批通知深链基地址 |
| TLS | `AIOPS_TLS_CERT_FILE` / `AIOPS_TLS_KEY_FILE` | 两个都设置才启用；反向代理终结 TLS 时可不设 |
| MCP | `MCP_*_TOKEN` + `${ENV_NAME}` 占位 | 上游 token 从环境注入，不写进 JSON 明文 |
| 模型 | `AIOPS_MODEL_BASE_URL` / `NAME` / `API_KEY` | 没有 provider 时的可选兜底 |
| 保留 | `AIOPS_APPROVAL_TTL_MS` / `TASK_RETENTION_DAYS` / `EVENT_RETENTION_DAYS` | 审批过期和任务/事件清理 |
| 巡检 | `AIOPS_MCP_HEALTH_MS` | 默认 30000；`0` 关闭 |
| 告警 | `AIOPS_ALERT_SOURCES_FILE` / `AIOPS_ALERT_MAX_CONCURRENCY` | 接入源文件默认 `data/alert-sources.json`，并发排查上限默认 3 |
| 可观测 | `AIOPS_METRICS_TOKEN` / `AIOPS_LOG_REQUESTS` | 指标鉴权和访问日志 |

不要提交 `.env`、`data/`、`backups/`、证书或私钥。仓库的 `.gitignore` / `.dockerignore` 已默认排除这些路径。

## 账号与权限

默认仍是本机 `x-actor-id` header 模式，适合单机调试。接团队或对外 API 时设置：

```sh
AIOPS_AUTH=local
AIOPS_ADMIN_USERNAME=admin
AIOPS_ADMIN_PASSWORD='至少12位的初始密码'
```

空库首次启动会创建管理员并标记需要改密；之后在「账号 → 用户管理」建用户，在「账号 → API Key」创建或轮换 key。token 只回显一次，数据库只存 SHA-256；轮换会签发同 scope 的新 key 并吊销旧 key。

| 角色 | 能力 |
| --- | --- |
| `viewer` | 查看自己可见的任务、知识和审批，不能执行工具 |
| `operator` | 提交任务、执行只读工具；变更进入审批 |
| `approver` | 审批别人名下的变更；查看自己发起的和有审批记录的任务 |
| `auditor` | 全量只读审计和任务可见性，不能执行变更 |
| `admin` | 用户、API key、MCP、资产、凭证、模型、通知等管理能力 |

普通客户端账号可以不设密码、只发 API key，用于 DSH/WorkBuddy；`approver`、`auditor`、`admin` 必须有密码。网页会话使用 HttpOnly Cookie + CSRF，API 使用 `Authorization: Bearer aiops_...`。本地管理员始终是 break-glass。

初始密码未修改前，网页会话只能访问身份、改密和登出接口，其它请求返回 403 `password_change_required`；「安全设置」可以查看并注销自己的网页会话（单个或其它全部）。登录失败计数在 MySQL 里共享，多副本不会各算各的。

API key scope 按接口校验：建任务要 `tasks:write`，调工具要 `tools:execute`，查任务/审批要 `tasks:read` / `approvals:read`，续跑审批要 `approvals:write`。

header 模式的演示身份：`alice`（operator）、`bob` / `dana`（approver）、`carol`（viewer）。

## MCP 接入与 token 认证

平台没有本地直连工具，外部系统一律通过上游 MCP 访问。MCP 可以在控制台「能力 → MCP」在线编辑，保存前会按新配置真实 `initialize` + `tools/list` 探测；失败返回 502，`data/mcp-servers.json` 保持原样。启动时单个 MCP 不可达只跳过并记录 `mcpErrors`，不会拖垮平台。

下面按常见形态各给一个示例：日志检索（Elasticsearch，全部只读）和一个有写权限的 K8s 集群。token 用环境变量占位，不要提交明文；页面里直接填明文也可以，平台会用 `secret-box` 加密落盘，接口和页面只回显 header 名。

日志检索：

```json
{
  "name": "es",
  "system": "elasticsearch",
  "url": "http://mcp-es-auth:8080/mcp",
  "readOnly": true,
  "mutateTools": [],
  "headers": {
    "Authorization": "Bearer ${MCP_ES_TOKEN}"
  }
}
```

K8s（上游 MCP 没有开 `--disable-write`，具备完整写权限）。`readOnly: true` 只是默认风险分类，**不在 `mutateTools` 里的工具会被当成只读自动执行**，所以必须把 `tools/list` 里的全部写工具列进来：

```json
{
  "name": "k8s-prod",
  "system": "kubernetes",
  "url": "http://mcp-k8s-prod-auth:8766/mcp",
  "readOnly": true,
  "mutateTools": [
    "k8s_create", "k8s_expose", "k8s_run", "k8s_set_resources", "k8s_set_image", "k8s_set_env",
    "k8s_rollout_undo", "k8s_rollout_restart", "k8s_rollout_pause", "k8s_rollout_resume",
    "k8s_scale", "k8s_autoscale", "k8s_cordon", "k8s_uncordon", "k8s_drain", "k8s_taint", "k8s_untaint",
    "k8s_exec_command", "k8s_port_forward", "k8s_cp", "k8s_apply", "k8s_patch", "k8s_label",
    "k8s_annotate", "k8s_delete", "kubectl", "helm"
  ],
  "headers": {
    "Authorization": "Bearer ${MCP_K8S_TOKEN}"
  }
}
```

对应在 `.env` 或运行环境里设置 `MCP_ES_TOKEN` / `MCP_K8S_TOKEN`。`${ENV_NAME}` 在每次请求时解析，缺失会报错；header 值用 `secret-box` 加密落盘，`GET /api/mcp-servers` 和页面只返回 header 名，不回显值。编辑时留空表示保持原值，删除要显式 `clearHeaders`。

也支持完全不带认证的 MCP，`headers` 省略即可。**平台只能决定“带不带 token”，不能替不校验 token 的上游做认证。** 要保证“只有平台能调用”，上游 MCP 必须自己校验 token，或在网关层校验；当前 K8s 清单没有做 NetworkPolicy/mTLS/认证代理，属于明确的已知边界。

风险分类：`readOnly` 不写或 `false` 时全部工具按变更处理（失败关闭）；`readOnly: true` 时只有 `mutateTools` 里的工具走审批。上游工具集会变，平台 health 检测到新增、移除或签名变化时标「需复核」，确认后把当前工具集设为新基线，新增的写工具要手动补进 `mutateTools`。不想维护列表就把 `readOnly` 设成 `false`，代价是读操作也要审批。

## 接入 DSH

### 本机 stdio 代理

DSH 用标准 MCP client 拉起：

```sh
AIOPS_API=http://127.0.0.1:8787 \
AIOPS_API_TOKEN='aiops_xxx' \
npm run mcp
```

代理优先使用 API key；header 模式下才用 `AIOPS_INTERNAL_TOKEN` + `AIOPS_ACTOR`。它暴露 `task.create`、`task.finish`、`task.get`、`task.cancel`、`approval.list`、`approval.get`、`approval.resume` 和全部知识/运维工具。

### 远程 MCP

平台也提供 `POST /mcp`（MCP Streamable HTTP），认证用 API key，scope 至少包含 `tools:execute`：

```text
POST https://aiops.example.com/mcp
Authorization: Bearer aiops_xxx
```

stdin 代理和远程 `/mcp` 共用 `extensions/mcp/src/agent.ts` 的会话逻辑、工具和审批规则。`/mcp` 会话保存在进程内存（30 分钟 TTL，最多 100 个），所以只支持单副本或粘性会话。DSH 的变更审批通过后平台自动 resume（外部任务没有本地 runner）；网页任务由本地 runner 自己续跑。

## API 示例

header 模式用 `x-actor-id`；账号模式换成 `Authorization: Bearer aiops_...`。

```sh
# 建任务
curl -s -X POST http://127.0.0.1:8787/api/tasks \
  -H 'content-type: application/json' -H 'x-actor-id: alice' \
  -d '{"prompt":"请重启 checkout-api"}'

# 看待审批
curl -s 'http://127.0.0.1:8787/api/approvals?status=pending' \
  -H 'x-actor-id: bob'

# 通过审批
curl -s -X POST http://127.0.0.1:8787/api/approvals/apr_xxx \
  -H 'content-type: application/json' -H 'x-actor-id: bob' \
  -d '{"decision":"approved","comment":"变更窗口内"}'

# 任务事件
curl -s http://127.0.0.1:8787/api/tasks/task_xxx/events -H 'x-actor-id: alice'
```

对外 Agent API 走 `/api/v1`：

```sh
curl -s -X POST http://127.0.0.1:8787/api/v1/tasks \
  -H 'authorization: Bearer aiops_xxx' -H 'content-type: application/json' \
  -d '{"prompt":"排查 checkout-api 为什么没起来","sessionId":"workbuddy-1"}'

curl -s -X POST http://127.0.0.1:8787/api/v1/tasks/task_xxx/tool-calls \
  -H 'authorization: Bearer aiops_xxx' -H 'content-type: application/json' \
  -d '{"tool":"mcp.k8s.k8s_get","args":{"resource":"pods","namespace":"shop"}}'
```

取消任务是 `POST /api/tasks/{taskId}/cancel`；有挂起审批时要带 `{"force":true}`，否则返回 409。`events?stream=1` 用 SSE 推同一批事件。完整契约见 [docs/openapi.json](docs/openapi.json)，运行中的平台也提供 `GET /openapi.json`。

知识检索：

```sh
curl -s -X POST http://127.0.0.1:8787/api/knowledge/search \
  -H 'content-type: application/json' -H 'x-actor-id: alice' \
  -d '{"query":"CrashLoop","top_k":3}'
```

## 部署到 Kubernetes

清单在 `deploy/k8s/`，入口是 `deploy/kustomization.yaml`：

```sh
cp deploy/k8s/secret.example.yaml /tmp/aiops-secret.yaml
# 编辑镜像、域名、AIOPS_PUBLIC_URL、数据库和加密密钥；不要提交真实 secret
kubectl apply -f /tmp/aiops-secret.yaml
kubectl apply -k deploy/
```

当前清单是简化版：平台和 MySQL 各 1 副本，只有平台建 Ingress，MCP 和 MySQL 的 ClusterIP 在集群内可达；不做 NetworkPolicy、mTLS 和认证代理。平台和上游 MCP 之间靠 header token 认证。多副本运行时每个副本要设置唯一 `AIOPS_INSTANCE_ID`，`/mcp` 需要粘性会话，任务 runner 不跨实例迁移；审批轮询、登录限速和后台清理已经共享 MySQL。RWO PVC 仍不能多挂。

生产请固定不可变镜像 tag，不要依赖 `latest`；MCP 和平台之间使用独立 token，并给上游 MCP 配置最小权限账号。详见 [deploy/k8s/README.md](deploy/k8s/README.md)。

## 备份与恢复

备份内容包括 MySQL 逻辑备份和整个 `data/`，用 AES-256-CBC + PBKDF2 加密，附 SHA-256 校验：

```sh
export BACKUP_PASSPHRASE='强口令'       # 或用 0600 的 backups/backup.passphrase
./deploy/backup.sh
# 产物：backups/aiops-YYYYmmdd-HHMMSS.tar.gz.enc 和 .sha256
```

K8s 用 `deploy/k8s/backup-cronjob.yaml`，每天 02:00 调同一脚本。默认保留 14 天，周日副本保留 56 天，可选 `BACKUP_RCLONE_REMOTE` 上传。

恢复前先停平台；脚本会先备份旧 `data/` 再替换：

```sh
BACKUP_PASSPHRASE='强口令' \
./deploy/restore.sh --file backups/aiops-YYYYmmdd-HHMMSS.tar.gz.enc --yes
```

只恢复到另一个库做演练用 `--target-db aiops_restore`；K8s/外部 MySQL 用 `RESTORE_MYSQL_MODE=host` 并设置 `AIOPS_DB_*`。**备份口令和 `AIOPS_SECRET_KEY` / `data/secret.key` 丢失都无法恢复加密数据。** 详见 [部署和备份](docs/使用手册.md#9-部署和备份)。

## 安全模型

- 所有工具调用经过 ToolBroker；没有审批就不能执行 mutate，拒绝/取消不能改集群，一个审批只能消费一次。
- 审批人不能批准自己提交的变更；`approval.resume` 会校验工具、参数 hash 和任务归属。
- 账号密码用 scrypt；API key 只存 SHA-256，明文只回显一次；会话 Cookie HttpOnly，写操作校验 CSRF。
- `data/` 权限 0600，敏感字段 AES-256-GCM；默认密钥文件与数据同机，只能防单独拷走文件，防不了主机被攻陷，生产建议用 `AIOPS_SECRET_KEY` 从外部注入并随数据备份。
- 日志、事件、审计和 API 不记录密码、token、私钥、webhook 完整 URL。
- SSH 必须做 host key 校验；没有信任指纹时 `ssh.test`/`ssh.exec` 直接拒绝，指纹不匹配必须断连，禁止跳过。
- 真实写操作需要单独接入具备写权限、最小 RBAC 的 MCP server；没有写工具时平台不会假装执行。

## 测试与开发约定

```sh
npm test                 # 139 个用例；带 .env 时 MySQL 集成测试会实跑，否则跳过
npm run typecheck
node --check web/app.js
npm run build            # 产出 dist/，供 Docker 镜像使用
```

改动必须经过 ToolBroker，审批规则不能放宽；`config` 只做种子、`data` 是权威；新增敏感字段必须走 `api/src/secret-box.ts`。工程约束和目录规范见 [CLAUDE.md](CLAUDE.md)，开发交接和验收记录见 [PROGRESS.md](PROGRESS.md)。

## 目录

```text
api/src/                 平台核心：HTTP、任务、审批、资产、凭证、MCP、SSH
api/test/                node:test 用例
extensions/knowledge/    本地 Markdown 和外部知识库 provider
extensions/ops-tools/    上游 MCP HTTP 客户端
extensions/mcp/          stdio MCP 代理（给 DSH）
extensions/aiops-skills/ SKILL.md + playbook.json
web/                     控制台：index.html、app.css、app.js、login
config/                  种子配置
data/                    运行时权威数据（gitignored，0600）
docs/                    使用手册和 OpenAPI
deploy/                  Dockerfile、Compose、K8s 清单、备份/恢复脚本
harness/                 只放 DSH 接入说明，不放引擎源码
```

## 当前边界

- 多实例：审批结果、登录限速和清理锁已共享 MySQL；通用限流、模型流式增量和 token 成本统计是进程内的；任务执行不迁移，`/mcp` 会话需要粘性，K8s 清单默认单副本。
- MCP 巡检只做 `initialize` + `tools/list`，不调用 `tools/call`；server 暴露但实际不可用的工具发现不了。
- 只有本地账号，不接 LDAP/OIDC/SAML；强制改密只拦截网页会话，不影响 API key。
- K8s 没有网络隔离和 mTLS；MCP 认证依赖上游自身校验。
- 热加载替换工具集会尽力关闭上一轮上游 session，关闭失败只记日志。
- 平台只用于本机/内网验证；对生产集群执行任何写操作前，必须确认 MCP 权限、变更窗口和回滚方案。

## 文档

- [使用手册](docs/使用手册.md)：完整操作、接口、真实数据接入、部署和排查。
- [K8s 部署说明](deploy/k8s/README.md)：Secret、Ingress、备份 CronJob、升级回滚。
- [OpenAPI](docs/openapi.json)：对外 Agent API 契约。
- [开发交接](PROGRESS.md)：已完成项、验收记录和断点。

## 许可证

[Apache License 2.0](LICENSE)。安全问题请按 [SECURITY.md](SECURITY.md) 私密报告，参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)。
