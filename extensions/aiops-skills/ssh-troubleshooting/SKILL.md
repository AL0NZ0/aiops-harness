---
name: ssh-troubleshooting
description: 通过 SSH 对已登记资产做主机侧只读取证（负载、内存、磁盘、进程、内核日志、网络），优先用 ssh.read / ssh.logs 直接取证，变更才走 ssh.exec 审批并校验主机密钥。
---

# SSH 主机排查

> 平台执行约定：只读工具（`ssh.test`、`ssh.read`、`ssh.logs`、`asset.*`）直接调用；`ssh.exec` 是变更工具，会返回 `awaiting_approval`，说明平台已挂起等审批，不要重复提交同一条命令，也不要调用 `task.*`、`approval.*`。审批被拒绝或命令失败时如实说明，不要绕过审批。只使用当前任务工具清单里的工具，不要直接连上游 MCP。

目标：容器、K8s 和日志证据不足时，登主机确认系统层状态。只做只读、有界、可复核的检查。

## 前提

- 先用 `asset.get` 确认资产存在，并看清环境、负责人、SSH 用户、跳板机（`sshJumpAsset`）和 `sshHostKeyFingerprint`。
- 没有信任指纹时 `ssh.test` / `ssh.read` / `ssh.logs` / `ssh.exec` 会被拒绝。让管理员在资产页「校验主机密钥」并确认指纹，不要尝试绕过校验。
- `ssh.test` 只验证连通、认证和主机密钥，不执行命令；连通确认通过后再取证。网页资产卡片的「测试连接」和它等价。
- `ssh.logs` 只能读资产 `sshReadPaths` 里声明的路径。`asset.get` 能看到这些路径；没有配置或目标不在范围内时，不要试图换路径硬读，改用 `ssh.exec` 走审批并说明原因。
- 不连生产主机做测试；只对用户明确指定的资产执行。环境等级不清楚时先查资产或问清楚，不要默认。

## 命令规范

- 先用 `ssh.read`，它直接执行不审批，命令必须在白名单内；不在白名单或用 `ssh.logs` 读文件，才考虑 `ssh.exec`。`ssh.exec` 即使命令只读也进入审批，一次提交一条命令，等审批结果，不要重复调用或并行试探。
- `ssh.read` 不接受管道、重定向、引号、通配符和命令替换，也不接受 `head` / `tail` 之类的截断参数；行数截断用 `journalctl -n`（1..500）。需要更自由的组合时走 `ssh.exec`。
- 只读检查示例（都是 `ssh.read` 命令）：
  - 负载与内存：`uptime`、`free -m`、`vmstat 1 3`
  - 磁盘：`df -h`、`df -i`、`lsblk`
  - 进程：`ps -eo pid,ppid,pcpu,pmem,etime,comm --sort=-pcpu`、`top -bn1`
  - 内核与系统日志：`dmesg -T --level=err,warn`、`journalctl -p err -n 100 --no-pager`、`systemctl --failed --no-pager`、`systemctl status <unit> --no-pager`
  - 网络：`ss -s`、`ss -lntp`、`ip -br addr`、`ip route`
- 日志文件用 `ssh.logs`：`path` 必须在资产 `sshReadPaths` 内，`lines` 1..500（默认 200），`grep` 是固定字符串（不是正则，也不能带空格）。先按时间线看 `lines`，再逐步加 `grep` 收窄，不要一次拉满。
- 禁止：交互式命令、`sudo` 修改系统、重启或停止服务、`kill`、`rm`/`mv`、改配置、写文件、重定向保存输出、`curl` 外部地址、读取私钥/凭据/token/环境文件。
- 输出里有敏感信息时先脱敏再写进结论；输出被截断时说明截断位置，不要当成完整结果。
- 跳板机由平台按 `sshJumpAsset` 自动转发，不要在命令里手工再跳。

## 结论要求

- 给出资产名、环境、执行的命令、关键输出和采集时间，按负载、内存、磁盘/inode、进程、内核日志、网络归类。
- 只报告实际输出；审批被拒绝、连接失败或命令超时要如实说明，不假装已经执行。
- 主机侧结论要说明是否足以解释上游现象；证据不足时写清还需要看什么。