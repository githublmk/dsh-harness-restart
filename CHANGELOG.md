# Changelog

## 0.4.1

- 修掉 `relaunch.mjs` 的静默退出：助手在等待壳/Host 消失时用了 `unref()` 定时器，事件循环被清空后进程直接退出，**壳已经停了但应用没被拉起**（真机 15:13 那次复现：日志停在 `host: shell gone`，应用是手动重开的）。现在 `sleep` 不再 unref，并额外用一个 keep-alive 定时器兜底；任何提前退出都会在日志里留下 `relauncher: exited code=…`。
- 新增 `test/relaunch-process.test.mjs`：在「两个 pid 都还活着」的场景下断言助手进程不会在等待循环中退出。
- 助手在 settle 等待之前写 `relaunch-launching` 回执，进程中途死掉也能在计划历史里看到尝试记录。
- 版本握手升到 0.4.1（`lib/config.js` 与两端一致，`test/plugin.test.mjs` 断言之；客户端冒烟测试的假 Host 版本直接从 `client.js` 读取，不再手抄）。

## 0.4.0

- 新增 `harness_restart` / `harness_restart_status` / `harness_restart_cancel` 三个工具：模型可以自己发起重启，用 `resume` 选恢复范围、用 `tasks` 排重启后任务、用 `dryRun` 只演练；调用前走 `ctx.approval` 审批卡。
- 新增**重启后自动续作**：重启瞬间正在回合中的所有根会话（`agents.roots()` + `turnBoundaryOf().openTurnStartSeq`）在重启后各自收到一条续作指令，经 `sessionController.prompt` 从检查点继续，不重做已完成的工作。
- 新增**自定义重启后任务**：重启后在新会话或指定会话里执行 `prompt`，可带 cwd / 预设 / 标题 / 执行时间。
- 新增持久化计划 `$DSH_HOME/harness-restart/plan.json`（原子写、TTL、状态机、损坏改名）与逐条回执 `history.jsonl`；`restart.lock` 保证按钮与工具不会同时停壳。
- 停壳前 `ctx.sessions.flush` 冲刷所有活会话；工具结果先返回、延迟 `restartDelayMs` 再停壳，保证这次调用落在会话日志里。
- 停壳失败会把计划标 `aborted` 并写回执，下次正常启动不会被意外续作；助手 `relaunch.mjs` 记录 `relaunch-ok` / `relaunch-failed` / `relaunch-abandoned` 回执。
- 按钮确认气泡新增「重启后继续被中断的会话」开关与「重启后任务」输入框；重启完成后页面显示「已恢复 N 个会话，启动 M 个任务」。
- `GET` 路由升级为版本 + 能力位 + 最近一次重启回执（`lastPlan`），版本握手升到 0.4.0。
- 新增 `lib/` 拆分（config / plan / policy / relaunch-core / resume / restart / text / tools）与 `node:test` 单测；客户端冒烟测试覆盖恢复开关、任务输入、Host 上限、请求被拒、旧/不支持 Host、双击只发一次、重启完成提示。
- 加固（评审后）：只有写入 `restarting` 的计划会被执行，遗留的 `armed` 计划在下次启动时作废（`plan-abandoned`）；停壳前重新读计划并复查助手进程，任一不满足即中止；重启锁由后继 Host 接管，回收陈旧锁改为 rename+内容校验；停壳前 flush 只统计已 settle 的会话；审批没有应答者时失败关闭（`approval-unavailable`）；新建任务会话先落盘再投递；`harness_restart_cancel` 需先拿到锁，不会删掉正在执行的计划；`relaunch.mjs` 在进程表不可读时不再重复拉起、坏 pid 跳过等待、日志目录先建；诊断 `PUT` 增加 `x-dsh-restart-probe` 闸。
- 客户端加固：watchdog 在请求前就武装（挂起的 POST 不会把按钮永久卡在「正在重启…」），双击只发一次，409 显示「已有一次重启正在进行」，按 Host 的 `resumeDefault` / `maxTasks` 预选开关与截断任务行，取消勾选后正文文案随动。
- 文档：README(.en)、`docs/mechanism.md` 增补恢复时序、幂等、加固点与排错表。

## 0.3.0

- 重启改由 `relaunch.mjs` 助手完成：在杀壳**之前**启动（`detached`、无管道），避免 `dsh-desktop-host` 的 `process.disconnect` 停机把「拉起应用」这一步一起带走。
- 助手优先用 `explorer.exe <应用 exe>`（双击等价路径）启动应用，并用 `tasklist` 轮询进程表确认应用进程出现且 4 秒后仍在；失败退回直接 spawn，最多 3 次。
- 应用 exe 取自运行中 Host 的 `process.execPath`，`tasklist` 的镜像名取自它的 `basename`，不写死安装目录。
- 安全门禁：助手写不出 ready 标记时请求直接 500，**壳不会被杀**。
- 客户端在弹确认框前先 `GET` 路由校验 Host 版本，不匹配则拒绝执行（防止新旧两半混用）。
- 客户端语言判定改为多源（locale 服务 → 文档 lang → `navigator.language`），并停用 `locale.bind()` 取值。
- 新增 `client-probe.log`：客户端挂载时上报语言来源，便于定位文案问题。
- 新增 `docs/mechanism.md`（三堵墙、时序、排错表）、`README.en.md`、`test/smoke-client.mjs`、CI。

## 0.2.0

- 修掉客户端语言取错字段的问题（`LocaleSnapshot` 的字段是 `active`）。
- 增加确认气泡与失败文案；按钮位置改为跟随「更多」启动器实时测量。

## 0.1.0

- 首个版本：`shell.overlay` 里的重启按钮 + Host 侧重启路由。
- 重启最初交给 PowerShell 助手完成（后续废弃，见 0.3.0）。
