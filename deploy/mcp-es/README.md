# Elasticsearch MCP 部署

一个目录就是一套：MCP 容器 + nginx 认证容器。复制目录、改 ES 地址/账号和 token，`docker compose up -d`，不用 `.env`。

## 1. 复制并改常量

```sh
cp -r deploy/mcp-es /opt/aiops/mcp-es
cd /opt/aiops/mcp-es
chmod 600 docker-compose.yml   # 里面要写 ES 密码
```

要改的地方：

| 位置 | 改什么 |
| --- | --- |
| `docker-compose.yml` 的 `ES_URL` | ES 地址，如 `http://10.0.0.30:9200`；跑在宿主机时可用 `http://host.docker.internal:9200` |
| `docker-compose.yml` 的 `ES_USERNAME` / `ES_PASSWORD` | 查询账号；只给这个账号读索引的权限即可 |
| `nginx.conf` 的 Bearer token | `openssl rand -hex 32` 生成，平台 header 用同一个值 |
| 服务名（可选） | 同时部署多套时改 `mcp-es` / `mcp-es-auth` |

compose 文件里的 ES 密码是明文（这是「不用 `.env`」的代价）：只放在复制出去的那份，别提交回仓库，`chmod 600`。平台那边存的 token 会加密落盘。

ES 只监听 `127.0.0.1` 时容器连不上：改成监听 `0.0.0.0` 或内网地址，或把 ES 接进 `aiops-net`。

启动：

```sh
docker compose up -d
docker compose ps
```

## 2. 验证

```sh
# 不带 token：预期 401
docker compose exec mcp-es-auth sh -c \
  'wget -S -O /dev/null http://127.0.0.1:8080/mcp' 2>&1 | grep -m1 'HTTP/'
# 带正确 token：预期不是 401
docker compose exec mcp-es-auth sh -c \
  'wget -S -O /dev/null --header="Authorization: Bearer <token>" http://127.0.0.1:8080/mcp' \
  2>&1 | grep -m1 'HTTP/'
```

## 3. 加到平台

「能力 → MCP」新增：

- 名称：`es`
- system：`elasticsearch`
- URL：`http://mcp-es-auth:8080/mcp`
- headers：`Authorization: Bearer <nginx.conf 里的 token>`
- `readOnly`：`true`，`mutateTools` 留空

## 4. 停止和升级

```sh
docker compose down
docker compose pull
docker compose up -d
```