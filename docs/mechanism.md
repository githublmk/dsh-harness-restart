# 重启机制与实现约束

这份文档记录实现这个按钮时踩到的三堵墙，以及现在的时序、每一步的验证点和排错方法。所有结论都来自本机（Windows 11 / Electron 44.7.0 / Desktop 0.2.1-rc.5）实测。

## 三堵墙

### 1. 「应用」菜单是原生菜单，插件插不进去

`DeepSeek Harness.exe` 的 main 进程用 `Menu.buildFromTemplate` 构建菜单，`applicationItems()` 里确实有「重启应用与 Host」：

```js
/* lib/main.js */
...development ? [
  { label: messages.reloadPageMenu, role: 'reload' },
  {
    label: messages.restartAppHostMenu,
    click: () => { if (quitting) return; app.relaunch(); quitWithoutConfirmation() },
  },
] : [],
```

但它被 `development` 包住，**打包版拿不到**；渲染端也只有被 `contextBridge` 白名单暴露的几个 API，没有 `ipcRenderer`。Cordis 插件能做的只是渲染端的东西，所以只能在菜单条上自建入口。

顺带一提：`app.relaunch()` 这条路径本身是可靠的（崩溃恢复对话框里的「重启」就是它），只是没有 IPC 能从页面或 Host 触发它。

### 2. 壳一死，Host 立刻自己走

Host（`dsh-desktop-host`）启动后注册了：

```js
/* lib/index.js:325 */
process.once('disconnect', () => { stop() })
```

`disconnect` 就是与 Electron main 的 IPC 通道断开。所以「Host 杀掉壳、再由 Host 拉起应用」在结构上不成立：杀壳的那一瞬间，Host 已经在优雅停机了。日志里表现为只有 `shell gone` 而没有后续：

```
2026-11-04T10:04:30.804Z restart requested host=27236 shell=21260
2026-11-04T10:04:30.807Z shell gone          ← 之后什么都没有
```

结论：**拉起应用的进程必须在杀壳之前就存在，并且与壳/ Host 都没有父子或管道关系。**

### 3. 客户端 bundle 是「激活时的内存快照」

`@deepseek-ai/dsh-client-modules` 在插件激活时用 `initialBundleSnapshot()` 读进 `client.js` 并缓存，revision 是文件的 `mtimeMs + ctimeMs + size`：

```js
function artifactRevision(baseline) {
  return framedHash('plugin-artifact', [String(baseline.mtimeMs), String(baseline.ctimeMs), String(baseline.size)])
}
```

所以改 `client.js` 之后：刷新页面**不够**，浏览器只是重新请求同一个（immutable）URL；必须**重开应用**让 Host 重新抓快照。

## 重启的设备与工具入口

`harness_restart`（以及按钮 `POST`）都走同一个 Host 函数 `lib/restart.js#requestRestart`：

1. 只允许桌面 Host（`process.versions.electron` + 合法 `ppid`）；
2. 抢 `restart.lock`（已有活跃计划则 `plan-busy`）；
3. 快照「重启瞬间正在回合中的会话」：根会话取 `ctx.agents.roots()`，正在运行的子智能体取 `ctx.agents.list()` 里的非根条目；两者都用 `turnBoundaryOf(session).openTurnStartSeq` 判断是否在回合中（正常结束或被用户中止的回合为 `null`）。子条目记下 `parentSession` 与 `delegationDepth`，因为恢复时只能由它的父会话冷启动；
4. 组装计划并**原子写** `$DSH_HOME/harness-restart/plan.json`（tmp + `fsync` + rename）；
5. 启动 `relaunch.mjs` 并等 ready 标记（拿不到就删计划、返回 `relaunch-unavailable`，**壳不动**）；
6. 计划改 `restarting`、写 `plan` 回执，返回给调用方；
7. **约 1.5 秒后**（`restartDelayMs`）flush 所有活会话 → `process.kill(ppid)` 停壳；停不掉则把计划标 `aborted` 并写回执。

第 7 步的延迟是必须的：工具结果由 agent loop 在 `execute` 返回后追加，先返回再杀进程，这次调用的结果才进得了会话日志，重启后的模型才能看到「我刚才请求过重启」。

## 现在的时序

```
页面/工具 ── 请求重启 ──▶ Host
                          │ 1. 写计划（plan.json，state=armed）
                          │ 2. spawn relaunch.mjs（ELECTRON_RUN_AS_NODE=1 跑同一个 exe，
                          │    detached、无管道；ready 标记写不出就中止）
                          │ 3. 计划改 restarting，返回结果（页面 202 / 工具结果）
                          │ 4. ~1.5s 后：flush 活会话 → process.kill(ppid)    ← 停壳
                          ▼
        （Host 自己的 disconnect 停机开始）
                          ▼
         relaunch.mjs 轮询 shell/host 是否都消失（≤20s）
                          │ 壳还活着 → 写 relaunch-abandoned 回执并退出（绝不启第二实例）
                          │ 停 2.5s，让端口与单实例状态落定
                          │ explorer.exe "<app exe>"（双击等价）→ tasklist 校验
                          ▼
        新 Host 启动
                          │ 5. 插件 apply() → scheduleBootRestore（延迟 bootDelayMs）
                          │ 6. 读计划：过期→expired；否则 state=executing
                          │ 7. 逐条投递续作/任务（stagger + 幂等 requestId）
                          │ 8. 计划 done + plan-done 回执；页面 GET 读到最近回执
```

安全性质：**拿不到助手的 ready 标记就绝不杀壳**；停壳失败会把计划标 `aborted`，下次正常启动不会被意外续作。

## 重启后恢复

投递用的是 Session Controller 的公开 API，不自己拼消息：

```js
await ctx.sessionController.prompt({
  sessionId,
  requestId: `restart-${planId}-resume-${sessionId}`,   // 固定 → 幂等
  mode: 'queue',                                        // followup：新回合
  content: [{ type: 'text', text: continuationText }],
}, signal)
```

`prompt` 内部会 `resolveAgent`（恢复冷会话、按 Session 记录的预设重新组装 Agent）、把消息写成 `user/message`（source `{ kind:'user', rpcId: requestId }`）再 `followup`。`hasPromptRequest` 会同时查收件箱和完整日志里的 `rpcId`，所以同一计划重跑一次不会重复投递。

新建「重启后任务」的会话用：

```js
const { sessionId } = await ctx.sessionController.create({ cwd, agentPreset })
// 可选：sessionController.rename({ sessionId, title })
await ctx.sessionController.prompt({ sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: prompt }] }, signal)
```

恢复引擎的约束：

- 一条失败不阻塞其它条目：`session/not-found`、`session/agent-busy`（子代理会话）标 `skipped`，其它标 `failed`，都写回执；
- 续作提示按条目生成：工具的 `continuation` 只写进发起重启的会话那一条 `continuationHint`，其他会话拿标准指令；给了 `continuation` 而本会话不在恢复范围时，请求在写计划前就以 `continuation-without-self` 被拒（调用方当时还活着，改参数只需一次）；
- 子智能体单独处理：重启瞬间在回合中的子会话以 `kind: 'subagent'` + `parentSession` + `delegationDepth` 入计划，按「根 → 浅 → 深」投递；子会话从不直接 `prompt`，而是 `subagents.prompt({ parentSessionId, childSessionId, mode:'continuable', delivery:'queue' })` 由**活着的直接父会话**冷启动（父会话先被续作，才可能活着）。父会话不在计划里（它当时没有开放回合，例如队长已结束回合、队员还在跑）时，先 `agents.resume({ resumeSessionId })` 把它 bare-resume 起来——子会话的结论要回给一个活着的父会话，这一步省不掉；唤醒后的父会话保持空闲，等子会话 `send_message` 来叫醒它。父会话救不回来、one-shot 子代理、旧 Host 没有 `subagents` 服务 → 记 `skipped`；`subagent/delivery-unavailable` 记 `failed`，下次启动再试；
- 每投递一条就重写 `plan.json`，Host 再次挂掉后只补没投的；
- `at` 未到的任务保持 `pending`，到点后（或下次启动）再投；
- 上限 `maxResumeSessions`、间隔 `staggerMs`，避免开机瞬间并发十几个模型请求。

## 为什么不能直接 `spawn(appExe)`

实测：直接以子进程启动 `DeepSeek Harness.exe`，进程**能起来**、主进程跑到了更新检查：

```
Checking for update
Staging percentage: 0.3, percentage: 0.9164524890753563, user id: 445e4ab2-...
Update for version 0.2.1-rc.5 is not available (latest version: 0.2.2-rc.1, downgrade is disallowed).
```

但**窗口不出现**，随后静默退出（`stderr` 为空、没有崩溃报告）。用 `explorer.exe <exe>` 启动则正常——差别在父进程、继承的环境和 `STARTUPINFO`。所以助手优先走 explorer，直接 spawn 只作为兜底。

同理，早期版本用 PowerShell 写脚本做这件事也行不通：`spawn('powershell.exe', [...], { detached: true })` 时脚本**一行都不会执行**（exit 0、无输出、无副作用），因为 `DETACHED_PROCESS` 下这个控制台程序直接空转退出。同理 `notepad.exe` 以 `detached` 方式启动也会立刻退出。这两点都是实测结论，不是推测。

## 版本握手

客户端在弹确认框前 `GET` 同一路由：

```json
{
  "ok": true,
  "version": "0.4.4",
  "supported": true,
  "capabilities": ["restart", "resume", "tasks"],
  "lastPlan": { "planId": "rst-…", "at": 0, "finishedAt": 0, "ok": true, "resumed": 2, "tasks": 1 }
}
```

`version !== VERSION` 时不发重启请求，只提示「当前 Host 还是旧版本，先重开一次应用再试」；`supported === false` 提示仅桌面端可用。`lastPlan` 同时用于重启后的「已恢复 N 个会话」提示。

## 语言解析

客户端文案不依赖 `ctx.locale.bind()`：client locale 快照里的 `active` 是 **`zh`**（不是 `zh-CN`），按 `zh-CN` 注册的词典查不到，会一路退回英文。现在的取值顺序是：locale 服务（`active`/`id`/`locale`）→ 文档上的 `lang`/`data-locale`/`data-language` → `navigator.language`，任一是 `zh*` 就走中文，否则 `en*` 走英文，都没有则中文。

续作指令的语言在 Host 侧决定：`continuationLanguage` 为 `zh`/`en` 时强制，`auto` 时读**发起重启的会话**最近一条用户消息（`session.snapshotEvents` 尾部 80 条），含汉字即中文，否则英文。按钮路径没有会话，用页面 POST 上来的 `language`。

## 排错表

| 日志 | 含义 | 处理 |
| --- | --- | --- |
| `host: assistant did not report ready` 且请求 500 | 助手没起来，壳没被杀 | 应用原样；看是否 `%TEMP%` 不可写 |
| `host: restart aborted: shell alive` + `plan-aborted` | 杀壳没生效 | 检查进程保护/权限；计划已作废，不会被下次启动执行 |
| `relauncher: shell is still running; not starting a second instance` | 杀壳没生效（在助手侧看到） | 同上；回执里是 `relaunch-abandoned` |
| `relauncher: shell launch produced no application process` | explorer 启动后进程表里没新增 | 兜底直接 spawn 已自动尝试，看 `launch-N.err.log` |
| `relauncher: launched through shell; application processes=N` | 成功 | 窗口应在几秒内出现 |
| `host: restore: plan expired; not executed` | 计划超过 TTL | 正常保护；需要续作就重新发起一次重启 |
| `relauncher: exited code=…` 出现在 `shell gone` 之后、没有 `launched` | 助手提前退出（例如事件循环被 unref 定时器清空） | 0.4.1 已修：`sleep` 不 unref，另有一个 keep-alive 定时器；`test/relaunch-process.test.mjs` 盯住这条性质 |
| 只有 `shell gone` 而完全没有 `relauncher:` 行 | 助手根本没起来（`%TEMP%` 不可写等） | 看同目录 `launch-*.err.log`；手动启动应用即可，计划会在 TTL 内继续执行 |
| `host: restore: sessionController unavailable; plan kept for the next start` | 恢复时服务没就绪 | 计划保留；下次启动再试 |
| `host: restore: resume <id> -> skipped` | 会话不存在/归子代理 | 正常；回执里有 `session/not-found` 或 `session/agent-busy` |
| `host: restore: resume <id> (subagent) -> skipped` | 子会话不可续作，或父会话没回来 | 回执里看 `subagent/not-resumable` / `subagent/parent-unavailable` / `subagents-unavailable`；要它继续只能让父会话重新派活 |
| `client-probe.log` 里 `resolved` 与界面语言不符 | 语言来源判定问题 | 看同一行的 `hints` |

## 0.4.0 的加固点

实现重启工具与自动续作时补上的一批约束（都对应一次真实失败模式）：

- **只有 `restarting` 计划会被执行**。计划先以 `armed` 落盘，等助手 ready 才改 `restarting`；如果进程在这两步之间挂掉，下次启动会把 `armed` 计划标成 `aborted` 并写 `plan-abandoned` 回执，**不会**补跑没发生过的重启。
- **停壳前重新核对**：定时器到点后重新读计划（要求 `planId` 与 `restarting` 都没变），并再次确认助手进程还活着；任一条不满足就中止（`plan-aborted` / `relaunch-assistant-gone`），不杀壳。
- **锁交给后继进程**：锁文件记录 `pid/at/host`，宿主死后由新 Host 在恢复前抢下并释放；回收陈旧锁时先把记录 rename 到一旁、核对内容确实是刚才判定陈旧的那份，避免两个进程互相删掉对方刚建的锁。
- **flush 只算真的完成**：停壳前的 `sessions.flush` 只把已 settle 的会话计入，超时/失败写日志；它只是数据的额外保险，计划本身仍然覆盖中断。
- **审批失败关闭**：`ctx.approval` 没有应答者时工具返回 `approval-unavailable`，不会「没问就重启」；确需无人值守时显式配 `requireApproval: false`。
- **任务的会话先落盘再投递**：新建会话后立刻写回 `plan.json`，Host 再挂掉也不会重复开新会话（续作用固定 `requestId` 去重）。
- **取消要拿锁**：`harness_restart_cancel` 先抢重启锁，抢不到说明请求正在执行，直接回答 `cancelled:false`，不会删掉已经排给定时器的计划。
- **拉起判定区分未知**：`relaunch.mjs` 在 `tasklist` 不可读时按「未知」处理、不再直接 spawn 第二个实例；pid 参数非法时跳过等待仍然拉起应用；日志目录先建再写。
- **语言探测接口也加闸**：`PUT /dsh-harness-restart/restart` 需要 `x-dsh-restart-probe: 1`，与 `POST` 的 `x-dsh-restart-action` 各管各的。

## 真机验证记录（2026-11-09 15:24，0.4.1）

一次完整的工具路径重启（计划 `rst-20261109-152417-pev6`，应用由助手自动拉起，非手动）：

| 时间 | 事件 |
| --- | --- |
| 15:24:17.409 | 计划写入（`origin: tool`，恢复本会话 + 1 个任务） |
| 15:24:17.9 | 助手 ready（pid 23508），Host 记录 `assistant ready` |
| 15:24:19.4 | `flushed 2 session(s)` → 杀壳 → `shell stopped; the relaunch assistant takes over` |
| 15:24:19.45 | `relauncher: shell and host are gone` |
| 15:24:22.4 | `shell launch: application processes before=1`（explorer 拉起） |
| 15:24:28.9 | `launched through shell; application processes=6` → `done` → `exited code=0` |
| 15:24:32.2 | 新 Host 续作投递本会话成功（`restore: resume … -> delivered`） |
| 15:24:33.1 | 任务投递到新会话 `session-171c1833…`（`task … -> delivered`） |
| 15:24:33.15 | `plan-done ok:true`，plan 状态 `done` |

这条记录同时证明 0.4.1 的修复有效：助手不再停在 `shell gone`，而是完整走完 `shell and host are gone → launched → done`。回执顺序为 `plan → shell-stopped → relaunch-host-gone → relaunch-launching → relaunch-ok → resume → task → plan-done`。

## 未走完的路（后续计划）

- 自动拉起在部分环境下仍可能失败（进程活着但窗口不出现）。计划在 TTL 内会在下次启动时执行，但这仍不是「可靠的拉起」。
- 真正的「一等公民」路径是给桌面壳补一个 IPC（需要改 `app.asar`，属于改应用本体，升级会被覆盖），让它支持 Host 发起的 `restart` 请求。
- 也可以让 Host 以 fatal 方式退出，由壳弹出 `重启 / 退出 / 禁用第三方插件` 对话框，用户点「重启」触发 `app.relaunch()`——这是整台机器上唯一被反复验证能可靠拉起的路径，代价是一次点击。
- `dsh web` / CLI 的 Host 自重启（同端口拉起、页面重连）尚未实现；本 bundle 目前在非桌面环境只返回 `desktop-only`。
