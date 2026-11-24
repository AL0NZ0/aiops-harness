---
id: cpu-payments
title: payments-api CPU 升高
source: wiki/runbooks/cpu.md
---

payments-api CPU 长期高于限额的 80% 时，先用 Prometheus 确认是哪一个 Pod，再按本地资产登记找到 pay-team。优先扩容或限流，不要直接重启作为第一步。
