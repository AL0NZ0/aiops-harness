---
name: ssh-troubleshooting
description: 通过 SSH 对已登记资产做主机侧只读取证（负载、内存、磁盘、进程、内核日志、网络、docker 版本、授权目录/文件），优先用 ssh.read / ssh.logs / ssh.ls / ssh.cat 直接取证，变更才走 ssh.exec 审批并校验主机密钥。
---

# SSH 主机排查

> 平台执行约定：只读工具（`ssh.test`、`ssh.read`、`ssh.logs`、`ssh.ls`、`ssh.cat`、`asset.*`）直接调用；`ssh.exec` 是变更工具，会返回 `awaiting_approval`，说明平台已挂起等审批，不要重复提交同一条命令，也不要调用 `task.*`、`approval.*`。审批被拒绝或命令失败时如实说明，不要绕过审批。只使用当前任务工具清单里的工具，不要直接连上游 MCP。

目标：容器、K8s 和日志证据不足时，登主机确认系统层状态。只做只读、有界、可复核的检查。

## 目标机器怎么选

- 先用 `asset.list`（或用户点名时用 `asset.get`）看每台资产的 `ssh` 状态：
  - `ssh.configured=true` 且 `ssh.status=up`：最近一次真实 SSH 登录成功，可以作为操作目标。
  - `ssh.status=down`：最近一次登录失败，`ssh.error` 有原因；不要盲目换一台机器顶替。
  - `ssh.status=unchecked`：还没跑过连接测试，不算可连接。
  - `ssh.configured=false`：缺主机、SSH 用户、凭证或信任指纹，`ssh.blockedReason` 说明缺什么；这类资产不能执行任何 `ssh.*` 工具，也不要尝试绕过。
- 用户指定了机器：先确认它的 `ssh.status=up`；`configured=true` 但 `unchecked` 或 `down` 时，先调一次 `ssh.test` 拿最新结果。仍然连不上、缺配置或资产不存在时，如实返回「没有可连接的机器」并说明原因（哪台、缺什么/报什么错），不要自动换成另一台资产。
- 用户没有指定机器：从 `ssh.status=up` 的资产里选一台最匹配的（环境、负责人、主机名），并在结论第一句写明实际用了哪台。没有一台可连接时直接返回「没有可连接的机器」，不要编造目标。
- 连接状态来自后台定时测试（最长约 10 分钟前），关键操作前用 `ssh.test` 再确认一次；`ssh.test` 只验证连通、认证和主机密钥，不执行命令。
- 没有信任指纹时 `ssh.test` / `ssh.read` / `ssh.logs` / `ssh.ls` / `ssh.cat` / `ssh.exec` 都会被拒绝。让管理员在资产页「校验主机密钥」并确认指纹，不要尝试绕过校验。
- `ssh.logs`、`ssh.ls`、`ssh.cat` 共用资产 `sshReadPaths` 里声明的路径，`asset.get` 能看到。`ssh.logs` 读日志尾部（`lines` 1..500，可固定串 `grep`），`ssh.ls` 列一层目录，`ssh.cat` 读小文件全文（上限 64KB）。没有配置或目标不在范围内时，不要试图换路径硬读，改用 `ssh.exec` 走审批并说明原因；不要要求平台放开任意 `cat`/`ls`。
- 不连生产主机做测试；只对用户明确指定或从可连接清单里选出的资产执行。环境等级不清楚时先查资产或问清楚，不要默认。

## 命令规范

- 先用 `ssh.read`，它直接执行不审批，命令必须在白名单内；不在白名单，或文件不在 `sshReadPaths` 内，才考虑 `ssh.exec`。`ssh.exec` 即使命令只读也进入审批，一次提交一条命令，等审批结果，不要重复调用或并行试探。
- **被拒一次就改用 `ssh.exec`**：`ssh.read` 报「不在只读白名单」后，换 `--version`、`systemctl show`、`ls`、`cat`、`journalctl` 的其它写法都不会通过，不要逐个试探；直接把原命令交给 `ssh.exec` 并等审批。同一条命令不要重复提交。
- `ssh.read` 只接受固定模板：`systemctl status <unit> --no-pager` 必须带 `--no-pager`；`journalctl` 必须带 `-n N`（1..500）和 `--no-pager`。不接受管道、重定向、引号、通配符和命令替换，也不接受 `head` / `tail` 之类的截断参数。
- 容器运行时只有 `docker version` 在白名单内；`docker info`、`docker ps`、`docker logs`、`docker inspect`、`kubectl version`、`ls`、`cat` 都不在，直接走 `ssh.exec`。
- 只读检查示例（都是 `ssh.read` 命令）：
  - 负载与内存：`uptime`、`free -m`、`vmstat 1 3`
  - 磁盘：`df -h`、`df -i`、`lsblk`
  - 进程：`ps -eo pid,ppid,pcpu,pmem,etime,comm --sort=-pcpu`、`top -bn1`
  - 内核与系统日志：`dmesg -T --level=err,warn`、`journalctl -p err -n 100 --no-pager`、`systemctl --failed --no-pager`、`systemctl status <unit> --no-pager`
  - 网络：`ss -s`、`ss -lntp`、`ip -br addr`、`ip route`
- 日志文件用 `ssh.logs`：`path` 必须在资产 `sshReadPaths` 内，`lines` 1..500（默认 200），`grep` 是固定字符串（不是正则，也不能带空格）。先按时间线看 `lines`，再逐步加 `grep` 收窄，不要一次拉满。
- 看目录用 `ssh.ls`（一次一层，不递归）；读配置文件（`daemon.json`、unit 文件等）用 `ssh.cat`。两者路径都必须在 `sshReadPaths` 内，软链逃逸和类型不符会被拒绝；超过 64KB 的文件改用 `ssh.logs`。路径没被授权就如实说明缺哪条，让管理员在资产上补 `sshReadPaths`，不要换路径猜。
- 禁止：交互式命令、`sudo` 修改系统、重启或停止服务、`kill`、`rm`/`mv`、改配置、写文件、重定向保存输出、`curl` 外部地址、读取私钥/凭据/token/环境文件。
- 输出里有敏感信息时先脱敏再写进结论；输出被截断时说明截断位置，不要当成完整结果。
- 跳板机由平台按 `sshJumpAsset` 自动转发，不要在命令里手工再跳。

## 结论要求

- 第一句写明实际操作的资产名和选择依据（用户指定，或从 `ssh.status=up` 的清单里选）。
- 给出资产名、环境、执行的命令、关键输出和采集时间，按负载、内存、磁盘/inode、进程、内核日志、网络归类。
- 只报告实际输出；审批被拒绝、连接失败、没有可连接的机器或命令超时要如实说明，不假装已经执行，也不要静默替换目标。
- 主机侧结论要说明是否足以解释上游现象；证据不足时写清还需要看什么。