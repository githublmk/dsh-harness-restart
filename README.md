# dsh-harness-restart

给 DeepSeek Harness 桌面端加一个 **重启** 按钮和一个 **重启工具** —— 点一下（二次确认）重启「应用与 Host」，重启完成后**被中断的会话会自动继续**，还可以在重启前排好重启后要执行的任务。

> 桌面端「应用」菜单是 Electron 原生菜单，打包版里没有「重启应用与 Host」这一项（只有开发版有），插件也无法往原生菜单插项。这个 bundle 走另一条路：在侧边栏面板列表里加一个「重启」入口（紧跟在「记忆」之后），同时把同一套重启能力做成 Agent 工具。

## 功能

- **侧边栏「重启」页面**：面板列表里紧跟「记忆」的一行，点开是重启确认页；页面上可以
  - 勾选「重启后继续被中断的会话」（默认勾选）；
  - 填写「重启后任务」（每行一条，可选）。
- **Agent 工具**：`harness_restart` / `harness_restart_status` / `harness_restart_cancel`，让模型自己发起重启并描述重启后要做什么。
- **自动续作**：重启瞬间正处在回合中的所有根会话**以及它们正在运行的子智能体**，开机后各自收到一条续作指令，从日志里的最后一个检查点继续，**不重做已完成的工作**；子智能体由它的父会话冷启动恢复，完成后用 `send_message` 把结论回传给父会话。
- **重启后任务**：默认各开一个新会话（可指定 cwd / 预设 / 标题 / 执行时间），也可以发到指定会话。
- **可观测**：计划、逐条回执、失败原因都在磁盘上；重启完成后的页面会提示「已恢复 N 个会话，启动 M 个任务」。

## 界面

- **入口**：侧边栏面板列表里的一行（`sidebar.panellist`，`order: 901`），紧跟在「记忆」（900）之后、「更多」之前。桌面、Web、手机布局都有这个入口；侧栏折叠成图标栏时它和其它入口一样只显示图标。
- **页面**：点开是「重启应用与 Host」页面——确认文案、恢复开关、重启后任务、失败原因都在页面上，「取消」回到会话。
- **只读校验**：页面挂载时先 `GET` 同一路由，确认 Host 版本与是否支持自动重启；旧 Host 或非桌面环境只给「取消」「重试」，绝不发重启请求。
- **交互**：点「重启」后按钮变成「正在重启…」；请求被拒在页面上说明原因。
- **文案**：中英双语。判定顺序是 locale 服务 → 文档 `lang` → `navigator.language`，按顺序取第一个能判定语言的来源，都判定不了才退回中文（细节见 [docs/mechanism.md](docs/mechanism.md#语言解析)）。

## 工具

三个工具在 Host 根的 tools 作用域注册，profile 级的一行 patch 即对全部 Agent 可见。

### `harness_restart`

| 参数 | 说明 |
| --- | --- |
| `reason` | 为什么要重启；写进计划、续作指令和日志 |
| `resume` | `interrupted`（默认，重启瞬间在回合中的所有根会话）／`self`（只本会话）／`none` |
| `sessions` | 显式恢复的会话 id 列表（给定时覆盖 `resume`） |
| `continuation` | 重启后**本会话**要做什么：只拼进调用方自己的续作指令，其他被恢复的会话看不到它 |
| `tasks[]` | `{ prompt, title?, newSession?, sessionId?, cwd?, agentPreset?, at? }`；重启后执行 |
| `dryRun` | `true` 只回报计划，不重启 |

行为要点：

- 调用前弹 **审批卡**（`ctx.approval`，可用 `requireApproval: false` 关掉）。用户拒绝/取消则不重启；没有可用应答者时也**不会**重启（返回 `approval-unavailable`，提示用户用侧边栏的「重启」页面）。只有**根会话**能发起（子智能体调用返回 `nested-agent`）。
- 审批通过后：写计划 → 启动 `relaunch.mjs` 并等 ready 标记 → 返回工具结果 → **约 1.5 秒后** flush 活会话并停壳。延迟是为了让这次工具结果先落进会话日志。
- 返回 `{ ok, planId, restarting, restartInMs, willResume[], tasks[], note }`；失败返回 `{ ok:false, code, message }`，常见 `desktop-only` / `plan-busy` / `relaunch-unavailable` / `shell-alive` / `not-approved` / `continuation-without-self`。

### `harness_restart_status`

读当前计划状态、最近一次重启的恢复/任务数量、仍未完成的条目。适合回答「上次重启恢复得怎么样」。

### `harness_restart_cancel`

删掉还没进入停壳阶段（`armed`）的计划；已开始执行的不能取消。

## 重启后自动续作

1. 重启前把「重启瞬间正在回合中的会话」写进计划：根会话和它们正在运行的子智能体（`agents.roots()` + `agents.list()`，用 `turnBoundaryOf(session).openTurnStartSeq` 判断是否在回合中；子代理以 `parentSession` + `delegationDepth` 记录归属，已正常结束/被用户中止的回合不会被选中）。
2. 新 Host 启动约 1.5 秒后读计划，先按「根会话 → 浅层子智能体 → 深层子智能体」的顺序投递：
   - 根会话：`sessionController.prompt({ sessionId, requestId: 'restart-<planId>-<session>', mode:'queue', content:[续作指令] })`，这条 API 自己负责恢复冷会话、重建 Agent、写入 user 消息并 `followup`。
   - 子智能体：`subagents.prompt({ requestId, parentSessionId, childSessionId, mode:'continuable', delivery:'queue', content:[续作指令] })`。子智能体从不被直接 prompt——Host 只允许从**活着的直接父会话**冷启动子会话，所以父会话必须先恢复；父会话当时没有开放回合（例如队长已结束回合、队员还在跑）时会先用 `agents.resume` 把它单独唤醒，让它接得住子会话的结论。父会话救不回来、或子会话不是 continuable（one-shot）时该条目记 `skipped`，不会重试。
3. 续作指令明确写着：先复述进度 → 从检查点继续 → 已完成的不重做 → 子智能体完成后 `send_message` 把结论回传给父会话 → 除非用户明确要求不要再调用 `harness_restart`。根会话的续作指令里还会列出「重启时你派出、已被单独恢复的子会话 id」，避免它重复派活。
4. **只有调用重启工具的会话能自定义自己重启后做什么**：工具的 `continuation` 只拼进该会话那一条续作指令；其他被恢复的会话（含子智能体）一律只收到标准指令，不会看到别人写的提示。给 `continuation` 时本会话必须在恢复范围里（`self` / `interrupted`，或 `sessions` 包含它），否则工具返回 `continuation-without-self`、不重启——这样调用方还来得及改参数，而不是重启后发现提示没人读。
5. 投递是**幂等**的：根会话的 `requestId` 固定，`prompt` 内部按它去重；计划逐条落盘，中途再挂也只补没投的。子智能体那条走 `subagents.prompt`（没有 `requestId` 去重），只在「子会话已接受、计划还没写盘」这一瞬间再挂时可能重复投递一次（见「限制」）。
6. 上限 `maxResumeSessions`（默认 8，**根会话与子智能体合计**，显式 `sessions` 也受这个上限约束）、间隔 `staggerMs`（默认 800ms）、计划 `planTtlMinutes`（默认 60 分钟）。`note` 只在确实会恢复本会话时才承诺「重启后本会话会自动续作」，并给出「恢复 N 个会话（含 M 个子智能体）」。

## 它是怎么重启的

完整说明见 [docs/mechanism.md](docs/mechanism.md)。一句话版本：

Host 是桌面壳（Electron main）的子进程，**壳一死 Host 就被 `disconnect` 事件带走**，所以 Host 不可能「杀壳之后再拉起应用」。真正的重启由 `relaunch.mjs` 完成——它在杀壳**之前**就启动（脱离父进程、无管道），等壳和 Host 都消失后，用**双击等价的方式**（`explorer.exe <应用 exe>`）把应用拉起来，并用进程表确认它真的活着；失败会重试，仍失败就退回直接启动。

安全性质：**拿不到助手的 ready 标记就绝不杀壳**；停壳失败会把计划标成 `aborted` 并写回执，下次正常启动**不会**被意外续作。应用 exe 取自运行中 Host 的 `process.execPath`，不写死安装目录。

## 安装

```powershell
plugin_manager install_bundle D:\path\to\dsh-harness-restart
```

`cordis.patch.yml` 会插入一行：

```yaml
- insert:
    - id: harness-restart
      name: 'dsh-harness-restart'
      config: {}
```

装完**重开一次应用**（Host 侧代码和客户端 bundle 都在应用启动时加载）。

## 配置

`config` 全部可省略：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `resume` | `interrupted` | 页面路径的默认恢复策略；重启页面初次打开时按它预选「继续会话」开关（用户在页面上的改动不会被 Retry 覆盖；工具以参数为准） |
| `requireApproval` | `true` | 工具是否走 `ctx.approval` 审批卡 |
| `maxResumeSessions` | `8` | 单次重启最多恢复多少个会话 |
| `staggerMs` | `800` | 两条续作之间的间隔 |
| `restartDelayMs` | `1500` | 工具返回后多久停壳 |
| `planTtlMinutes` | `60` | 未执行的计划多久后作废 |
| `continuationLanguage` | `auto` | `auto` 跟随对话语言；`zh` / `en` 强制 |
| `flushTimeoutMs` | `3000` | 停壳前 flush 活会话的预算 |
| `bootDelayMs` | `1500` | 开机后多久开始恢复 |
| `maxTasks` | `8` | 单次重启最多排多少个任务（也决定重启页面最多接受几行任务） |
| `storeDir` | `null` | 覆盖计划目录（默认 `$DSH_HOME/harness-restart`） |

### 关闭工具审批（可选）

会话的审批策略是 `never` 时，审批卡不会被弹出，工具会按「失败关闭」返回 `not-approved`（没有应答者时是 `approval-unavailable`）；`requireApproval: true` 下工具因此无法重启。希望工具直接重启时，在 **profile** 的 `cordis.patch.yml` 里覆盖这一行：

```yaml
- id: harness-restart
  config:
    requireApproval: false
```

代价是模型可以在没有卡片的情况下重启应用（侧边栏「重启」页面不受影响，它本来就有自己的确认）。改了 patch 后若 profile 开启 `patchReload: live`，通常几秒内生效，否则下次启动生效。

## 数据与日志

**计划与回执**：`$DSH_HOME\harness-restart\`

| 文件 | 内容 |
| --- | --- |
| `plan.json` | 当前/最近一次重启计划（原子写：tmp + fsync + rename；损坏时改名 `plan.json.corrupt-*`） |
| `history.jsonl` | 逐条回执：`plan` / `resume` / `task` / `plan-done` / `plan-aborted` / `relaunch-*` |
| `restart.lock` | 单次重启互斥锁（持有者进程已死则可被新 Host 接管） |

**时序日志**：`%TEMP%\dsh-harness-restart\`

| 文件 | 内容 |
| --- | --- |
| `restart.log` | 一次重启的完整时序：`assistant ready` → `shell gone` → `flushed N session(s)` |
| `client-probe.log` | 重启页面挂载时上报的语言来源，排查文案问题用 |
| `launch-N.out.log` / `launch-N.err.log` | 直接启动尝试的 stdout/stderr（走 explorer 路径时不会产生） |

## 限制与已知问题

- **仅 Windows 桌面端**。其余环境工具返回 `desktop-only`，路由返回 `409 desktop-only`。
- 重启是「停壳 + 拉起」，不走壳的优雅退出流程：**进行中的回合会被中断**，然后由续作机制接着做；被中断的那一步不会原地续跑（harness 的崩溃恢复只补齐回合边界）。
- 只有写入 `restarting` 的计划才会被执行：助手就绪之前进程就挂掉留下的 `armed` 计划，下次启动会作废（回执 `plan-abandoned`），不会被补跑。
- 停壳前会 flush 活会话；flush 超时只记日志、不会无限等待（计划本身仍然覆盖这次中断）。
- 客户端 bundle 是 Host 激活时的内存快照，改 `client.js` **必须重开应用**，刷新页面不够。
- 自动拉起在个别环境里可能失败（进程起来、窗口不出现）。日志里能看出来，兜底就是手动双击启动；计划在 TTL 内仍会在下次启动时执行。
- 客户端在发请求前先读 `GET` 路由校验 Host 版本；旧 Host（或非桌面环境）不执行，避免两半不匹配。
- 续作会真的发起模型请求（这是目的），一次重启最多恢复 `maxResumeSessions` 个会话（根会话 + 子智能体合计）；如果只想重启不想续作，用 `resume: 'none'`。
- 子智能体只有 **continuable** 的能续作（它的会话里有 continuation 状态，`send_message` 也能续）；one-shot 子代理、父会话已归档、父会话救不回来（`agents.resume` 失败）时的子会话，会记 `skipped`（`subagent/not-resumable` / `subagent/parent-unavailable`），不会重试。
- 记 `failed` 的条目（例如 `subagent/delivery-unavailable`、别的暂时性错误）会把计划留在 `executing`，**下一次启动时自动重试**，直到计划过期（`planTtlMinutes`，默认 60 分钟）。`skipped` 不重试。

## 开发

```powershell
npm run check   # node --check 全部入口与 lib
npm test        # 计划/策略/文案/恢复引擎单测 + 客户端无头冒烟
```

`test/smoke-client.mjs` 用最小 React 替身和假 Host 跑真实的 `client.js`；`lib/*` 的单测用真实文件系统（临时目录）与假 `sessionController`，不需要 Harness。

## License

MIT
