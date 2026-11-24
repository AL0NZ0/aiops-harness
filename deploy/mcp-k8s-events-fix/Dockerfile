# 修复 feiskyer/mcp-kubernetes-server 0.1.12 的 k8s_events 排序 bug：
# last_timestamp/first_timestamp 为 None 时排序键回退成字符串 ""，与 datetime 比较抛
# TypeError: '<' not supported between instances of 'str' and 'datetime.datetime'。
#
# 依赖完全沿用上游镜像，只替换 events.py 一个模块，不重新装包、不需要出网。
# 上游源码 commit：e1184f8c7c010a09be8dcc89094fe7f6d67bd1b0（0.1.12）
ARG BASE=ghcr.io/feiskyer/mcp-kubernetes-server:0.1.12
FROM ${BASE}

USER root
COPY events.py /usr/local/lib/python3.12/site-packages/mcp_kubernetes_server/events.py
USER mcp