---
id: crashloop-checkout
title: checkout-api CrashLoopBackOff
source: wiki/runbooks/checkout.md
---

checkout-api 反复重启时，先看应用日志里的数据库连接。常见原因是 PostgreSQL 10.0.0.12:5432 拒绝连接（ECONNREFUSED）。确认 本地资产登记里的负责人是 shop-team，不要在没有审批的情况下删除 Pod。
