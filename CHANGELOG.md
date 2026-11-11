# Changelog

## 0.4.4

- **恢复范围包含子智能体**：重启瞬间正在回合中的子会话也会入计划（`kind: 'subagent'` + `parentSession` + `delegationDepth`），开机后按「根 → 浅 → 深」投递；子会话从不直接 `prompt`，而是由**活着的直接父会话**经 `subagents.prompt({ mode:'continuable', delivery:'queue' })` 冷启动，这正是 Host 允许的唯一路径。
- 父会话没回来、子会话不可续作（one-shot）、或旧 Host 没有 `subagents` 服务 → 该条目记 `skipped`（`subagent/parent-unavailable` / `subagent/not-resumable` / `subagents-unavailable`），不重试；`subagent/delivery-unavailable` 记 `failed`，下次启动再试。
- 续作文案分两版：子智能体版要求「完成后用 `send_message` 把结论发回父会话」；根会话版列出「重启时你派出、已被单独恢复的子会话 id」，避免重复派活。
- 工具先做静态矛盾检查：`continuation` 与 `resume: 'none'`（或 `sessions` 不含本会话）互斥时，在弹审批卡**之前**就返回 `continuation-without-self`，不再让用户先批准一次注定中止的重启。
- `restartNote` / `willResume` 带上子智能体信息：`note` 写「恢复 N 个会话（含 M 个子智能体）」，`willResume` 每条带 `kind`。
- 文档：README(.en)、`docs/mechanism.md`、`docs/plan-restart-tool.md` 同步子智能体恢复路径、错误分类与「已知窄窗口」（`subagents.prompt` 无 `requestId` 去重，Host 恰在两次写盘之间再挂可能重复投递一次）；顺手修掉审批 `unavailable` 的旧描述（实际是 `approval-unavailable` 失败关闭）。
- 单测：子智能体候选（含无父会话的孤儿被排除）、根先于子的投递顺序、父会话不在即 `skipped`、`not-resumable` / `delivery-unavailable` 的分类、旧 Host 降级、计划里提示与血缘只落在各自条目。
- 版本握手升到 0.4.4。

## 0.4.3

- 修正 `continuation` 的作用域：它由发起重启的会话书写，现在只拼进**该会话**的续作指令（`resume` 条目上的 `continuationHint`），不再复制给所有被恢复的会话——之前别人的提示会出现在无关会话的续作文案里。
- 新增失败码 `continuation-without-self`：给了 `continuation` 但本会话不在恢复范围（`resume: 'none'`、`sessions` 未包含它、被归档）时，工具在写计划前就拒绝并说明怎么改，而不是重启后把提示悄悄丢掉。
- `restartNote` 不再对不会被恢复的会话承诺「重启后本会话会自动续作」。
- 工具定义、README(.en)、`docs/plan-restart-tool.md`、`docs/mechanism.md` 同步说明「只有调用重启工具的会话能自定义自己重启后做什么」。
- 单测：续作提示只落在发起会话那一条、本会话不在范围时拒绝、`restartNote` 的新文案与错误码。
- 版本握手升到 0.4.3。

## 0.4.2

- 助手不再写第二条 `shell-stopped` 回执：它记录 `relaunch-host-gone`（Host 侧的 `shell-stopped` 保留），回执口径不再重复。
- README(.en) 增补「关闭工具审批」的 profile 覆盖示例：会话审批策略为 `never` 时工具会失败关闭（`not-approved`），要直接重启需显式设 `requireApproval: false`。
- `docs/mechanism.md` 增加 2026-11-09 15:24 的 0.4.1 真机验证时序（助手自动拉起、续作与任务投递、`plan-done`）。
- 版本握手升到 0.4.2。

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
