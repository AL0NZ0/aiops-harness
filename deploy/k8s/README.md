# K8s 部署（单副本）

面向小规模生产/预发：平台 1 副本 + MySQL 1 副本，不做 NetworkPolicy、不做 mTLS、不加认证代理。
平台和上游 MCP 之间靠 header token 认证；平台本身由 Ingress + 账号体系保护。

## 组件

| 资源 | 说明 |
| --- | --- |
| `aiops` Deployment | 平台，单副本，RWO PVC，非 root 10001，只读根文件系统 |
| `mysql` Deployment/Service | MySQL 8.4，数据在 `aiops-mysql-data` PVC |
| `aiops-data` PVC | `data/`：资产、凭证、MCP 配置、知识、`secret.key` |
| `aiops-backups` PVC | 加密备份，CronJob 每天 02:00 写入 |
| `aiops` Service | ClusterIP 8787，只有 Ingress 暴露它 |
| `aiops-backup` CronJob | mysqldump + data 打包，AES-256 加密 |
| `preflight.sh` | 只读部署检查，不打印 Secret 值 |

MCP 和 MySQL 都不建 Ingress。远程 DSH 走同一个平台入口下的 `/mcp`，仍然要 API key（scope `tools:execute`）。
ConfigMap 里的 `platform.json` 不预置上游 MCP；部署后在「能力 → MCP」按集群内 Service 地址添加，token 用 Secret 注入的环境变量。

## 前置条件

- 集群有默认 StorageClass，能动态创建 RWO PVC。
- 有 nginx Ingress Controller；内网默认 HTTP，TLS Secret 只在启用 HTTPS 时需要。
- 镜像已推到集群能拉的仓库；镜像内已包含 `dist/`、`web/`、`config/`、`docs/openapi.json`。
- 已准备 `aiops-secrets` 和 `mysql-secrets`。`deploy/k8s/secret.yaml` 已被 `.gitignore` 忽略，**不要提交真实值**。

## 部署步骤

以下命令未在你的集群验证过，执行前先 `--dry-run=client` 看清单。

```sh
# 0. 建 namespace，后面的 Secret 才能创建
kubectl --context <ctx> apply -f deploy/k8s/namespace.yaml

# 1. 创建 Secret（按 secret.example.yaml 填真实值；建议用 External Secrets）
#    所有 replace-with-* 都要替换；AIOPS_INTERNAL_TOKEN 覆盖 ConfigMap 里空的 internalToken。
#    AIOPS_METRICS_TOKEN 保护 /metrics，Prometheus 抓取时要带同一个 Bearer token。
kubectl --context <ctx> -n aiops create secret generic aiops-secrets \
  --from-literal=AIOPS_ADMIN_USERNAME=admin \
  --from-literal=AIOPS_ADMIN_PASSWORD='...' \
  --from-literal=AIOPS_SECRET_KEY='...' \
  --from-literal=AIOPS_INTERNAL_TOKEN='...' \
  --from-literal=AIOPS_METRICS_TOKEN='...' \
  --from-literal=BACKUP_PASSPHRASE='...' \
  --from-literal=MCP_K8S_TOKEN='...' \
  --from-literal=MCP_VM_TOKEN='...' \
  --from-literal=MCP_ES_TOKEN='...'
kubectl --context <ctx> -n aiops create secret generic mysql-secrets \
  --from-literal=MYSQL_ROOT_PASSWORD='...' \
  --from-literal=MYSQL_USER=aiops \
  --from-literal=MYSQL_PASSWORD='...' \
  --from-literal=MYSQL_DATABASE=aiops

# 内网 HTTP 不需要 TLS Secret；只有启用 HTTPS 时才创建：
# kubectl --context <ctx> -n aiops create secret tls aiops-tls --cert=tls.crt --key=tls.key

# 2. 改访问地址和镜像 tag。
#    - configmap.yaml 的 AIOPS_PUBLIC_URL：http://<IP或域名>[:端口]
#    - ingress.yaml 默认不绑定 host，IP 和域名都能访问；要限制域名时加 host
#    - kustomization.yaml 的 newTag：必须用不可变 tag 或 digest，不要用 latest
kubectl --context <ctx> apply -k deploy/ --dry-run=client
kubectl --context <ctx> apply -k deploy/

# 部署后检查占位符、Cookie、访问地址、TLS 和镜像 tag；不会打印 Secret 值。
CONTEXT=<ctx> ./deploy/k8s/preflight.sh

# 3. 等 MySQL 和平台起来
kubectl --context <ctx> -n aiops rollout status deploy/mysql
kubectl --context <ctx> -n aiops rollout status deploy/aiops

# 4. 验证
kubectl --context <ctx> -n aiops port-forward svc/aiops 8787:8787
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/ready
```

首次启动时平台自动建表并跑迁移，空库用 `AIOPS_ADMIN_USERNAME` + `AIOPS_ADMIN_PASSWORD` 建管理员，角色是 `admin + operator + approver`。
这个密码只在 MySQL 用户表为空时使用；首次登录会强制改密，之后改密码在页面里做。
如果复用已有 MySQL 数据，Secret 里的初始密码不会重置已有管理员。

`AIOPS_ADMIN_PASSWORD` 至少 12 位，建议每个环境单独生成：
`openssl rand -base64 24`。`AIOPS_INTERNAL_TOKEN`、MCP token 和数据库密码也用同样方式生成。

## 加密密钥（AIOPS_SECRET_KEY）

`AIOPS_SECRET_KEY` 是 `data/` 敏感字段的 AES-256-GCM 主密钥，不是 admin 密码、API key 或备份口令。

- **全新部署、不迁移本机 `data/`**：用 `openssl rand -base64 32` 生成一把填进 Secret，不需要额外改代码或清单。
- **不要把 `secret.example.yaml` 的占位值直接部署**：占位值不是合法的 32 字节 key，平台启动时会报错。
- **迁移已有 `data/` 或恢复该环境的备份**：Secret 必须使用原环境的 `data/secret.key` 内容，不能新生成，否则 `enc:v1:` 字段无法解密，平台起不来。
- K8s 同时有 `AIOPS_SECRET_KEY` 和 `data/secret.key` 时，环境变量优先；两者不一致会以环境变量为准，仍然解不开旧数据。
- 数据落盘后不能更换 key，平台没有自动换钥工具。
- key 必须单独备份，和 `BACKUP_PASSPHRASE` 分开保管；丢失后加密凭证和备份都无法恢复。

## 内网 HTTP 与 TLS

默认按内网 HTTP 部署，Ingress 不绑定 host，IP 或域名都能访问：

- `deploy/k8s/deployment.yaml` 的 `AIOPS_COOKIE_SECURE` 必须是 `0`。HTTP 下设为 `1` 浏览器不会回传会话 Cookie，登录会立刻失效。
- `AIOPS_TRUST_PROXY=1` 已在 Deployment 里设置：平台从 `X-Forwarded-For` 最右侧取客户端 IP，登录限流和安全事件不会都记成 Ingress Pod IP。它只适合「平台只能经 Ingress 访问」的拓扑；如果集群内其他 Pod 能直连 Service，恶意 Pod 仍可伪造该头，需要网络策略或去掉这个开关。该方案还依赖 Ingress 默认把真实对端追加到 XFF；如果改过 `use-forwarded-headers` 之类信任客户端头的配置，需要关掉。
- `deploy/k8s/configmap.yaml` 的 `AIOPS_PUBLIC_URL` 写成 `http://<IP或域名>[:端口]`。告警回调地址和审批深链都用它拼接。
- 用 IP 访问不需要改 Ingress；用域名访问也直接可用。要限制只允许某个域名时，给 `ingress.yaml` 的 rule 加 `host`。
- 不要设置 `AIOPS_TLS_CERT_FILE` / `AIOPS_TLS_KEY_FILE`。平台自己跑 HTTPS 时，K8s 的 HTTP probe 和 Dockerfile 的 HTTP HEALTHCHECK 都会失败；当前方案是 Ingress 终结 TLS，平台在集群内保持 HTTP。
- 如果确实要平台直连 HTTPS，必须同时改 Dockerfile HEALTHCHECK、K8s 三个 probe 的 `scheme: HTTPS`，以及 Ingress 的 backend 协议，不建议作为默认方案。
- 内网 HTTP 的登录密码、API key、告警 Token 会在局域网内明文传输；只适合可信网段，不要把 Ingress 暴露到不可信网络。

如果启用 HTTPS：恢复 `ingress.yaml` 的 `tls` 段并创建 `aiops-tls`，把 `AIOPS_COOKIE_SECURE` 改成 `1`，`AIOPS_PUBLIC_URL` 改成 `https://...`；平台仍然在集群内跑 HTTP，由 Ingress 负责证书。

## 镜像 tag 与预检

`kustomization.yaml` 的 `newTag` 必须是不可变 tag（例如 `v2026.11.23-1`）或 `digest: sha256:...`。`latest` + `IfNotPresent` 在节点已有旧镜像时不会重新拉取，升级可能不生效。

`deploy/k8s/preflight.sh` 是只读检查，部署前后都可以跑：

```sh
CONTEXT=<ctx> ./deploy/k8s/preflight.sh
```

它检查 namespace、两个 Secret 是否存在、`AIOPS_SECRET_KEY` 长度是否合法、密码和 token（含 `AIOPS_METRICS_TOKEN`）是否还是占位值、`AIOPS_PUBLIC_URL` / Ingress 是否还是示例值、HTTP 与 `AIOPS_COOKIE_SECURE` 是否匹配、Ingress 后面的 `AIOPS_TRUST_PROXY`、Ingress TLS 与访问地址是否一致，以及镜像地址是否还是示例值或 `latest`。只输出字段名，不打印 Secret 值。

## MCP 认证

平台连接上游 MCP 时支持可选 headers，值里可以引用环境变量：

```json
{
  "name": "k8s",
  "url": "http://k8s-mcp.mcp.svc:8080/mcp",
  "headers": { "Authorization": "Bearer ${MCP_K8S_TOKEN}" }
}
```

- 没有配置 `headers` 就匿名连接，兼容不带认证的 MCP。
- 页面和 `GET /api/mcp-servers` 只显示 header 名，不返回值；值留空表示保持原值。
- 删除 header 要显式 `"clearHeaders": ["Authorization"]` 或 `"clearHeaders": true`。
- 上游 MCP 必须自己校验 token。平台只能“带上 token”，不能替一个不校验的上游做认证。
- 保存配置前平台会按新配置探测上游；探测失败返回 502，旧配置不动。

## Prometheus 抓取

`/metrics` 在 Ingress 后面也能被访问，所以 Secret 里的 `AIOPS_METRICS_TOKEN` 是必填项。Prometheus 抓取配置要带同一个 token：

```yaml
scrape_configs:
  - job_name: aiops
    metrics_path: /metrics
    authorization:
      credentials: <AIOPS_METRICS_TOKEN>
    static_configs:
      - targets: ['aiops.aiops.svc:8787']
```

没有设置 token 时平台仍会启动，但启动日志会告警，`preflight.sh` 也会失败。

## 告警上线前检查

1. 跑一遍只读 MCP 的 `tools/list`，对照平台 `/api/tools` 和「能力 → MCP」的工具风险：`readOnly: true` 只是默认分类，不在 `mutateTools` / `excludeTools` 里的写工具会被当成只读暴露给告警任务。
2. 检查 `GET /api/tool-policies` 和 `data/tool-policies.json`，不要保留把写工具覆盖成 `read` 的记录；签名失效的覆盖会自动回退，但仍然建议删除残留。
3. 告警用的 MCP 账号用最小权限，只读不等于低权限；不要让这个账号能读 Secret、ConfigMap 或执行命令。
4. 告警排查会把告警内容、日志和 `describe` 输出发给所选模型 provider；先确认数据合规、provider 的外发策略和网络可达范围。
5. 告警源勾选的通知渠道保存时会校验是否存在；仍被引用的 webhook 不能直接删除。推送结果写在任务过程的「告警结果通知」事件里，失败不会改变任务状态。

## 备份与恢复

CronJob 每天 02:00 执行 `deploy/backup.sh`，产物在 `aiops-backups`：
`aiops-<时间戳>.tar.gz.enc` + `.sha256`，周日额外留一份 weekly。
保留期默认 14 天 / weekly 56 天，可用 `BACKUP_RETENTION_DAYS`、`BACKUP_WEEKLY_RETENTION_DAYS` 调整。

手动触发：

```sh
kubectl --context <ctx> -n aiops create job --from=cronjob/aiops-backup aiops-backup-manual
kubectl --context <ctx> -n aiops logs -f job/aiops-backup-manual
```

恢复会停平台，先在非生产演练：

```sh
kubectl --context <ctx> -n aiops scale deploy/aiops --replicas=0
# 改 deploy/k8s/restore-job.example.yaml 里的归档文件名，然后在集群内跑：
kubectl --context <ctx> -n aiops apply -f deploy/k8s/restore-job.example.yaml
kubectl --context <ctx> -n aiops logs -f job/aiops-restore
kubectl --context <ctx> -n aiops delete job/aiops-restore

kubectl --context <ctx> -n aiops scale deploy/aiops --replicas=1
```

这个 Job 用 `mysql:8.4` 镜像，`RESTORE_MYSQL_MODE=host` 直连 `mysql:3306`；脚本和凭据来自
`aiops-backup-script` ConfigMap 与 Secret。PVC 挂载点不能直接 `mv`，脚本会把旧 `data/`
复制到 `aiops-backups` 的 `data.bak.<时间戳>` 再清空恢复，所以备份 PVC 要留出至少一份 data 的空间。
恢复后必须用同一个 `AIOPS_SECRET_KEY`，否则 `enc:v1:` 凭证无法解密。

## 升级与回滚

- 升级：改 `kustomization.yaml` 的 image tag，`kubectl apply -k deploy/`，等 rollout。
- 回滚：`kubectl -n aiops rollout undo deploy/aiops`，镜像回到上一版。
- 数据库迁移只做加列/加表，旧版本可以继续读；回滚前仍建议先手动触发一次备份。
- `AIOPS_SECRET_KEY` 不能换；换 key 后旧数据无法解密。
- 清单固定单副本：RWO PVC 不能多挂，任务 runner 和 `/mcp` 会话也不跨实例。审批轮询、登录限速、后台清理已共享 MySQL；改多副本时需要 RWX/外部存储、每个副本唯一 `AIOPS_INSTANCE_ID`，并给 `/mcp` 配粘性。

## 已知边界

- 默认内网 HTTP 不做传输加密；只在可信网络使用，跨网段或不可信网络要启用 Ingress TLS。
- 不做网络隔离；MCP/MySQL 的 ClusterIP 在集群内可被其他 Pod 访问，靠上游 token 和 MySQL 密码保护。
- 平台只支持上游 MCP 的 Streamable HTTP；不支持 SSE。
- 平台不代理 MySQL；MySQL 的备份/恢复由 CronJob 和 `restore.sh` 负责。
- 备份口令和 `AIOPS_SECRET_KEY` 丢失都无法恢复，必须单独保管。