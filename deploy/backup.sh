#!/usr/bin/env bash
# 平台备份：MySQL 逻辑备份 + data/ 打包，加密后落盘。
# 宿主机 cron、K8s CronJob 共用；不依赖平台进程。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '[backup] %s\n' "$*" >&2; }
fail() { log "失败：$*"; exit 1; }

DATA_DIR="${AIOPS_DATA_DIR:-$ROOT_DIR/data}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
WEEKLY_RETENTION_DAYS="${BACKUP_WEEKLY_RETENTION_DAYS:-56}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
MYSQL_MODE="${BACKUP_MYSQL_MODE:-auto}"

[ -d "$DATA_DIR" ] || fail "数据目录不存在：$DATA_DIR"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR" 2>/dev/null || true

# 同一时间只允许一个备份，避免两个进程写同名文件。
LOCK_DIR="$BACKUP_DIR/.backup.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  fail "已有一个备份在运行（${LOCK_DIR}）"
fi
TMP_DIR=""
cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
  [ -n "$TMP_DIR" ] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# 加密口令：优先环境变量，其次 0600 文件；都没有就拒绝，不生成易丢的密钥。
PASS_ARG=""
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  PASS_ARG="env:BACKUP_PASSPHRASE"
else
  PASS_FILE="${BACKUP_PASSPHRASE_FILE:-$BACKUP_DIR/backup.passphrase}"
  if [ -f "$PASS_FILE" ]; then
    [ "$(stat -c '%a' "$PASS_FILE" 2>/dev/null || stat -f '%Lp' "$PASS_FILE" 2>/dev/null)" = "600" ] \
      || fail "口令文件权限必须是 600：$PASS_FILE"
    PASS_ARG="file:$PASS_FILE"
  else
    fail "缺少备份口令：设置 BACKUP_PASSPHRASE，或创建 0600 的 $PASS_FILE"
  fi
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aiops-backup.XXXXXX")"

# 优先用 compose 里的 MySQL 客户端（凭据已经在容器环境里，不出现在宿主机参数里）。
dump_mysql() {
  local out="$1"
  if [ "$MYSQL_MODE" = "docker" ] || { [ "$MYSQL_MODE" = "auto" ] && command -v docker >/dev/null 2>&1 \
      && docker compose -f "$COMPOSE_FILE" ps mysql --status running 2>/dev/null | grep -q mysql; }; then
    docker compose -f "$COMPOSE_FILE" exec -T mysql sh -c \
      'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump -u"$MYSQL_USER" --single-transaction --routines --triggers --events --no-tablespaces --set-gtid-purged=OFF "$MYSQL_DATABASE"' > "$out" \
      || fail "docker compose mysqldump 失败"
    return
  fi
  command -v mysqldump >/dev/null 2>&1 || fail "没有 mysqldump，也没有可用的 compose MySQL"
  [ -n "${AIOPS_DB_PASSWORD:-}" ] || fail "设置 AIOPS_DB_PASSWORD 或使用 compose MySQL"
  MYSQL_PWD="$AIOPS_DB_PASSWORD" mysqldump \
    -h "${AIOPS_DB_HOST:-127.0.0.1}" -P "${AIOPS_DB_PORT:-3306}" \
    -u "${AIOPS_DB_USER:?缺少 AIOPS_DB_USER}" \
    --single-transaction --routines --triggers --events --no-tablespaces --set-gtid-purged=OFF \
    "${AIOPS_DB_NAME:?缺少 AIOPS_DB_NAME}" > "$out" || fail "mysqldump 失败"
}

log "导出 MySQL"
dump_mysql "$TMP_DIR/mysql.sql"
[ -s "$TMP_DIR/mysql.sql" ] || fail "MySQL 导出为空"

log "打包 data/"
COPYFILE_DISABLE=1 tar -C "$DATA_DIR" -czf "$TMP_DIR/data.tar.gz" . || fail "打包 data 失败"

STAMP="$(date +%Y%m%d-%H%M%S)"
cat > "$TMP_DIR/manifest.json" <<EOF
{
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "host": "${HOSTNAME:-unknown}",
  "dataDir": "$DATA_DIR",
  "mysqlDumpSha256": "$(sha256 "$TMP_DIR/mysql.sql")",
  "dataArchiveSha256": "$(sha256 "$TMP_DIR/data.tar.gz")"
}
EOF

COPYFILE_DISABLE=1 tar -C "$TMP_DIR" -czf "$TMP_DIR/archive.tar.gz" manifest.json mysql.sql data.tar.gz
OUT="$BACKUP_DIR/aiops-$STAMP.tar.gz.enc"
log "加密归档"
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$TMP_DIR/archive.tar.gz" -out "$OUT" -pass "$PASS_ARG" || fail "加密失败"
chmod 600 "$OUT"
sha256 "$OUT" > "$OUT.sha256"

if [ "$(date +%u)" = "7" ]; then
  mkdir -p "$BACKUP_DIR/weekly"
  cp "$OUT" "$BACKUP_DIR/weekly/"
  cp "$OUT.sha256" "$BACKUP_DIR/weekly/"
fi

if [ -n "${BACKUP_RCLONE_REMOTE:-}" ] && command -v rclone >/dev/null 2>&1; then
  rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE" || log "rclone 上传失败（本地备份已完成）"
fi

# 清理过期备份；只在文件名匹配时删除，避免误删。
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'aiops-*.tar.gz.enc*' -mtime +"$RETENTION_DAYS" -delete
find "$BACKUP_DIR/weekly" -maxdepth 1 -type f -name 'aiops-*.tar.gz.enc*' -mtime +"$WEEKLY_RETENTION_DAYS" -delete 2>/dev/null || true

log "完成：$OUT"
log "校验：$OUT.sha256"