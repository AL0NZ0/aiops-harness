#!/usr/bin/env bash
# 从 deploy/backup.sh 生成的加密归档恢复 MySQL 和 data/。
# 默认停掉 compose 里的平台再恢复；外部/K8s 部署请先自行停 Pod，再跑本脚本。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

log() { printf '[restore] %s\n' "$*" >&2; }
fail() { log "失败：$*"; exit 1; }

ARCHIVE=""
YES=0
NO_START=0
TARGET_DB=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) ARCHIVE="${2:-}"; shift 2 ;;
    --target-db) TARGET_DB="${2:-}"; shift 2 ;;
    --no-start) NO_START=1; shift ;;
    --yes) YES=1; shift ;;
    -h|--help)
      echo "用法: $0 --file backups/aiops-YYYYmmdd-HHMMSS.tar.gz.enc --yes [--target-db NAME] [--no-start]"
      exit 0 ;;
    *) fail "未知参数：$1" ;;
  esac
done

[ -n "$ARCHIVE" ] || fail "必须指定 --file"
[ -f "$ARCHIVE" ] || fail "归档不存在：$ARCHIVE"
DATA_DIR="${AIOPS_DATA_DIR:-$ROOT_DIR/data}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-$ROOT_DIR/docker-compose.yml}"
MYSQL_MODE="${RESTORE_MYSQL_MODE:-auto}"
STAMP="$(date +%Y%m%d-%H%M%S)"

PASS_ARG=""
if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  PASS_ARG="env:BACKUP_PASSPHRASE"
else
  PASS_FILE="${BACKUP_PASSPHRASE_FILE:-$ROOT_DIR/backups/backup.passphrase}"
  [ -f "$PASS_FILE" ] || fail "缺少备份口令：设置 BACKUP_PASSPHRASE 或 $PASS_FILE"
  PASS_ARG="file:$PASS_FILE"
fi

if [ "$YES" -ne 1 ]; then
  log "将恢复："
  log "  归档：$ARCHIVE"
  log "  数据目录：${DATA_DIR}（现有目录会改名为 data.bak.${STAMP}）"
  if [ -n "$TARGET_DB" ]; then log "  目标库：${TARGET_DB}（只恢复数据库，不动 data）"; else log "  数据库：${AIOPS_DB_NAME:-compose 默认库}"; fi
  fail "确认后重新执行并加 --yes"
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aiops-restore.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

log "解密归档"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$ARCHIVE" -out "$TMP_DIR/archive.tar.gz" -pass "$PASS_ARG" \
  || fail "解密失败，检查口令"
tar -C "$TMP_DIR" -xzf "$TMP_DIR/archive.tar.gz" || fail "解包失败"
[ -f "$TMP_DIR/mysql.sql" ] || fail "归档里没有 mysql.sql"
[ -f "$TMP_DIR/data.tar.gz" ] || fail "归档里没有 data.tar.gz"

# 先解压数据到临时目录，确认能解再替换现有 data，避免恢复一半。
mkdir -p "$TMP_DIR/data"
tar -C "$TMP_DIR/data" -xzf "$TMP_DIR/data.tar.gz" || fail "data 解包失败"

STOPPED=0
if [ -z "$TARGET_DB" ] && [ "$MYSQL_MODE" != "host" ]; then
  if command -v docker >/dev/null 2>&1 \
      && docker compose -f "$COMPOSE_FILE" ps aiops --status running 2>/dev/null | grep -q aiops; then
    log "停止平台容器"
    docker compose -f "$COMPOSE_FILE" stop aiops
    STOPPED=1
  fi
fi

# host 模式：直接连 AIOPS_DB_*，用于 K8s 或外部 MySQL。
# 不指定 TARGET_DB 时恢复到 AIOPS_DB_NAME。
restore_mysql_host() {
  local database="$1"
  command -v mysql >/dev/null 2>&1 || fail "host 模式需要 mysql 客户端"
  MYSQL_PWD="${AIOPS_DB_PASSWORD:?缺少 AIOPS_DB_PASSWORD}" mysql \
    -h "${AIOPS_DB_HOST:-127.0.0.1}" -P "${AIOPS_DB_PORT:-3306}" \
    -u "${AIOPS_DB_USER:?缺少 AIOPS_DB_USER}" \
    -e "CREATE DATABASE IF NOT EXISTS \`$database\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci" \
    || fail "创建目标库失败"
  MYSQL_PWD="$AIOPS_DB_PASSWORD" mysql \
    -h "${AIOPS_DB_HOST:-127.0.0.1}" -P "${AIOPS_DB_PORT:-3306}" \
    -u "$AIOPS_DB_USER" "$database" < "$TMP_DIR/mysql.sql" \
    || fail "导入 $database 失败"
}

# 没有宿主机 mysql 客户端时，用 compose MySQL 容器里的 root 建库并导入。
restore_mysql_compose() {
  local database="$1"
  case "$database" in
    *[!A-Za-z0-9_]*) fail "库名只允许字母、数字和下划线：$database" ;;
  esac
  docker compose -f "$COMPOSE_FILE" exec -T mysql sh -c \
    "MYSQL_PWD=\"\$MYSQL_ROOT_PASSWORD\" mysql -uroot -e \"CREATE DATABASE IF NOT EXISTS $database CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci\"" \
    || fail "创建目标库失败"
  docker compose -f "$COMPOSE_FILE" exec -T mysql sh -c \
    "MYSQL_PWD=\"\$MYSQL_ROOT_PASSWORD\" mysql -uroot \"$database\"" < "$TMP_DIR/mysql.sql" \
    || fail "导入 $database 失败"
}

log "恢复数据库"
if [ -n "$TARGET_DB" ]; then
  if [ "$MYSQL_MODE" = "host" ] || command -v mysql >/dev/null 2>&1; then
    restore_mysql_host "$TARGET_DB"
  elif command -v docker >/dev/null 2>&1; then
    restore_mysql_compose "$TARGET_DB"
  else
    fail "恢复指定库需要 mysql 客户端或 docker compose"
  fi
  log "数据库恢复完成：${TARGET_DB}（data 未改动）"
elif [ "$MYSQL_MODE" = "host" ]; then
  restore_mysql_host "${AIOPS_DB_NAME:?host 模式需要 AIOPS_DB_NAME}"
  log "数据库恢复完成：$AIOPS_DB_NAME"
else
  docker compose -f "$COMPOSE_FILE" exec -T mysql sh -c \
    'MYSQL_PWD="$MYSQL_PASSWORD" exec mysql -u"$MYSQL_USER" "$MYSQL_DATABASE"' < "$TMP_DIR/mysql.sql" \
    || fail "compose MySQL 恢复失败"
  log "数据库恢复完成"
fi

if [ -z "$TARGET_DB" ]; then
  log "恢复 data/"
  mkdir -p "$(dirname "$DATA_DIR")"
  if [ -d "$DATA_DIR" ]; then
    # 普通目录直接改名；PVC 挂载点不能 mv，先复制到 backups 再清空。
    if mv "$DATA_DIR" "${DATA_DIR}.bak.$STAMP" 2>/dev/null; then
      log "旧数据已移到 ${DATA_DIR}.bak.$STAMP"
    else
      OLD_DATA_BACKUP="$BACKUP_DIR/data.bak.$STAMP"
      mkdir -p "$OLD_DATA_BACKUP"
      cp -a "$DATA_DIR/." "$OLD_DATA_BACKUP/" || fail "备份旧 data 失败"
      find "$DATA_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} + || fail "清空旧 data 失败"
      log "旧数据已复制到 $OLD_DATA_BACKUP"
    fi
  fi
  mkdir -p "$DATA_DIR"
  cp -a "$TMP_DIR/data/." "$DATA_DIR/"
  if [ "$(id -u)" = "0" ] && [ -n "${AIOPS_UID:-}" ]; then
    chown -R "$AIOPS_UID:${AIOPS_GID:-$AIOPS_UID}" "$DATA_DIR"
  fi
  chmod 700 "$DATA_DIR" 2>/dev/null || true
  find "$DATA_DIR" -maxdepth 1 -type f -exec chmod 600 {} \; 2>/dev/null || true
fi

if [ "$STOPPED" -eq 1 ] && [ "$NO_START" -eq 0 ]; then
  log "启动平台"
  docker compose -f "$COMPOSE_FILE" start aiops
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:${AIOPS_HTTP_PORT:-8787}/health" >/dev/null 2>&1; then
      log "平台已就绪"
      break
    fi
    sleep 1
  done
fi

if [ -n "$TARGET_DB" ]; then
  log "恢复完成：只恢复了数据库 ${TARGET_DB}，data 未改动。"
else
  log "恢复完成。请检查 /health、登录、工具列表和审批数据；旧数据目录保留为 ${DATA_DIR}.bak.${STAMP}（PVC 场景在 ${BACKUP_DIR}）。"
fi