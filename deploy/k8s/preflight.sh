#!/usr/bin/env bash
# 只读检查 K8s 部署前的关键配置；不会打印 Secret 值。
# 用法：CONTEXT=<kube-context> ./deploy/k8s/preflight.sh
set -euo pipefail

CONTEXT="${CONTEXT:-}"
NAMESPACE="${NAMESPACE:-aiops}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
errors=0

if [[ -z "$CONTEXT" ]]; then
  cat >&2 <<'EOF'
用法: CONTEXT=<kube-context> ./deploy/k8s/preflight.sh
必须显式指定 context，脚本不会使用 kubectl 默认值。
EOF
  exit 2
fi

ok() { printf 'ok   %s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; errors=$((errors + 1)); }

secret_value() {
  kubectl --context "$CONTEXT" -n "$NAMESPACE" get secret "$1" \
    -o go-template="{{with index .data \"$2\"}}{{. | base64decode}}{{end}}" 2>/dev/null
}

check_required() {
  local name=$1 key=$2 value
  if ! value=$(secret_value "$name" "$key"); then
    fail "读取 $name/$key 失败（Secret 不存在或缺 key）"
    return
  fi
  if [[ -z "$value" ]]; then
    fail "$name/$key 为空"
    return
  fi
  if [[ "$value" == replace-with-* || "$value" == change-me* ]]; then
    fail "$name/$key 仍是占位值"
    return
  fi
  ok "$name/$key"
}

check_optional() {
  local name=$1 key=$2 value
  if ! value=$(secret_value "$name" "$key"); then
    ok "$name/$key 未设置（可选）"
    return
  fi
  if [[ -z "$value" || "$value" == "<no value>" ]]; then
    ok "$name/$key 未设置（可选）"
  elif [[ "$value" == replace-with-* || "$value" == change-me* ]]; then
    fail "$name/$key 仍是占位值"
  else
    ok "$name/$key"
  fi
}

check_length() {
  local name=$1 key=$2 min=$3 value
  if ! value=$(secret_value "$name" "$key"); then
    fail "读取 $name/$key 失败"
    return
  fi
  if (( ${#value} < min )); then
    fail "$name/$key 长度小于 $min"
  else
    ok "$name/$key 长度"
  fi
}

# 清单静态检查：占位地址、latest 镜像。
if ! manifest=$(kubectl --context "$CONTEXT" kustomize "$ROOT/deploy" 2>&1); then
  fail "kubectl kustomize 失败：$manifest"
  manifest=""
fi
if [[ -n "$manifest" ]]; then
  if grep -q 'change-me' <<<"$manifest"; then
    fail "清单仍有 change-me 占位值"
  else
    ok "清单无 change-me"
  fi
  if grep -q 'aiops\.example\.com' <<<"$manifest"; then
    fail "清单仍有 aiops.example.com 示例地址"
  else
    ok "清单无示例地址"
  fi
  if grep -Eq 'image:[[:space:]]*[^[:space:]]+:latest([[:space:]]|$)' <<<"$manifest"; then
    fail "清单仍有 latest 镜像"
  else
    ok "清单无 latest 镜像"
  fi
  if grep -q 'registry\.example\.com' <<<"$manifest"; then
    fail "镜像地址仍是 registry.example.com 示例"
  else
    ok "清单无示例镜像仓库"
  fi
fi

# namespace 和 Secret 必须先存在。
if kubectl --context "$CONTEXT" get namespace "$NAMESPACE" >/dev/null 2>&1; then
  ok "namespace/$NAMESPACE"
else
  fail "namespace/$NAMESPACE 不存在，先 apply deploy/k8s/namespace.yaml"
fi

check_required aiops-secrets AIOPS_ADMIN_USERNAME
check_required aiops-secrets AIOPS_ADMIN_PASSWORD
check_required aiops-secrets AIOPS_SECRET_KEY
check_required aiops-secrets AIOPS_INTERNAL_TOKEN
check_required aiops-secrets BACKUP_PASSPHRASE
check_required aiops-secrets MCP_K8S_TOKEN
check_required aiops-secrets MCP_VM_TOKEN
check_required aiops-secrets MCP_ES_TOKEN
check_required aiops-secrets AIOPS_METRICS_TOKEN

check_required mysql-secrets MYSQL_ROOT_PASSWORD
check_required mysql-secrets MYSQL_USER
check_required mysql-secrets MYSQL_PASSWORD
check_required mysql-secrets MYSQL_DATABASE

check_length aiops-secrets AIOPS_ADMIN_PASSWORD 12
check_length aiops-secrets AIOPS_INTERNAL_TOKEN 16
check_length aiops-secrets AIOPS_METRICS_TOKEN 16
check_length aiops-secrets BACKUP_PASSPHRASE 12
check_length mysql-secrets MYSQL_ROOT_PASSWORD 12
check_length mysql-secrets MYSQL_PASSWORD 12

# AES key 必须是 64 位 hex 或 base64 解码后的 32 字节。
if key=$(secret_value aiops-secrets AIOPS_SECRET_KEY); then
  if [[ -z "$key" ]]; then
    fail "AIOPS_SECRET_KEY 为空"
  elif [[ "$key" =~ ^[0-9a-fA-F]{64}$ ]]; then
    ok "AIOPS_SECRET_KEY 格式"
  else
    if ! bytes=$(printf '%s' "$key" | openssl base64 -d -A 2>/dev/null | wc -c | tr -d ' '); then
      fail "AIOPS_SECRET_KEY 不是合法 base64"
    elif [[ "$bytes" != "32" ]]; then
      fail "AIOPS_SECRET_KEY 解码后不是 32 字节"
    else
      ok "AIOPS_SECRET_KEY 格式"
    fi
  fi
else
  fail "读取 aiops-secrets/AIOPS_SECRET_KEY 失败"
fi

# Deployment / Ingress 运行时检查；未部署时跳过。
public_url=""
cookie_secure=""
trust_proxy=""
if kubectl --context "$CONTEXT" -n "$NAMESPACE" get deploy aiops >/dev/null 2>&1; then
  image=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get deploy aiops \
    -o jsonpath='{.spec.template.spec.containers[0].image}' 2>/dev/null || true)
  if [[ "$image" == *:latest ]]; then
    fail "Deployment 镜像仍使用 latest：$image"
  else
    ok "Deployment 镜像 $image"
  fi

  cookie_secure=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get deploy aiops \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="AIOPS_COOKIE_SECURE")].value}' 2>/dev/null || true)
  trust_proxy=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get deploy aiops \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="AIOPS_TRUST_PROXY")].value}' 2>/dev/null || true)
  public_url=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get configmap aiops-config \
    -o jsonpath='{.data.AIOPS_PUBLIC_URL}' 2>/dev/null || true)

  if [[ -z "$public_url" ]]; then
    fail "ConfigMap aiops-config 缺少 AIOPS_PUBLIC_URL"
  elif [[ "$public_url" == *example.com* ]]; then
    fail "AIOPS_PUBLIC_URL 仍是示例地址"
  else
    ok "AIOPS_PUBLIC_URL $public_url"
  fi

  case "$public_url" in
    http://*)
      if [[ "$cookie_secure" == "0" ]]; then
        ok "HTTP + AIOPS_COOKIE_SECURE=0"
      else
        fail "HTTP 访问但 AIOPS_COOKIE_SECURE 不是 0，浏览器不会回传会话 Cookie"
      fi
      ;;
    https://*)
      if [[ "$cookie_secure" == "1" ]]; then
        ok "HTTPS + AIOPS_COOKIE_SECURE=1"
      else
        fail "HTTPS 访问但 AIOPS_COOKIE_SECURE 不是 1"
      fi
      ;;
    *)
      fail "AIOPS_PUBLIC_URL 不是 http(s) 地址"
      ;;
  esac

  for key in AIOPS_TLS_CERT_FILE AIOPS_TLS_KEY_FILE; do
    if value=$(secret_value aiops-secrets "$key"); then
      if [[ -n "$value" && "$value" != "<no value>" ]]; then
        fail "检测到 $key：平台 TLS 与 HTTP probe 冲突；改用 Ingress TLS 或同步修改 probe"
      fi
    fi
  done
else
  ok "Deployment 尚未部署，跳过运行时检查"
fi

if kubectl --context "$CONTEXT" -n "$NAMESPACE" get ingress aiops >/dev/null 2>&1; then
  if [[ "$trust_proxy" == "1" ]]; then
    ok "Deployment AIOPS_TRUST_PROXY=1（信任 Ingress 的最右侧 XFF）"
  else
    fail "Ingress 后面未设置 AIOPS_TRUST_PROXY=1；限流和安全事件会把 Ingress Pod IP 当成客户端 IP"
  fi

  hosts=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get ingress aiops \
    -o jsonpath='{range .spec.rules[*]}{.host}{"\n"}{end}' 2>/dev/null || true)
  if grep -q 'example\.com' <<<"$hosts"; then
    fail "Ingress host 仍是示例地址"
  elif [[ -z "${hosts//[[:space:]]/}" ]]; then
    ok "Ingress 未绑定 host（IP 或任意域名可访问）"
  else
    ok "Ingress host: $hosts"
  fi

  tls_names=$(kubectl --context "$CONTEXT" -n "$NAMESPACE" get ingress aiops \
    -o jsonpath='{range .spec.tls[*]}{.secretName}{"\n"}{end}' 2>/dev/null || true)
  if [[ -n "${tls_names//[[:space:]]/}" ]]; then
    while IFS= read -r tls_name; do
      [[ -z "$tls_name" ]] && continue
      if kubectl --context "$CONTEXT" -n "$NAMESPACE" get secret "$tls_name" >/dev/null 2>&1; then
        ok "Ingress TLS Secret/$tls_name"
      else
        fail "Ingress TLS Secret/$tls_name 不存在"
      fi
    done <<<"$tls_names"
    if [[ "$public_url" == http://* ]]; then
      fail "Ingress 配了 TLS，但 AIOPS_PUBLIC_URL 是 http"
    fi
  else
    ok "Ingress 未启用 TLS"
    if [[ "$public_url" == https://* ]]; then
      fail "AIOPS_PUBLIC_URL 是 https，但 Ingress 未配置 TLS"
    fi
  fi
else
  ok "Ingress 尚未部署，跳过"
fi

if (( errors > 0 )); then
  printf '\n检查失败：%d 项\n' "$errors" >&2
  exit 1
fi
printf '\n检查通过\n'