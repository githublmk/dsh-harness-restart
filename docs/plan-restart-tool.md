# 实现方案：重启工具 + 重启后自动续作 + 自定义重启后任务

> 状态：**已实现（0.4.0）**。本文件保留为设计记录；与实现不一致处以下面这条为准。
> 结论都来自本机运行中的 Host（`cordis_inspect_query` 实时目录）与 `D:\codeSpace\js\dsh_code`（0.2.1-rc.2 源码）。
>
> 实现差异：选择策略落在 `lib/policy.js`；新增 `lib/config.js`（配置默认值与 `VERSION`）；版本、能力位与「最近一次重启」由同一个 `GET /dsh-harness-restart/restart` 返回，没有单开 `/status`；`harness_restart_status` 返回 `{ ok, active, plan, last, unfinished }`（字符串字段，避免嵌套 schema 校验风险）。

## 1. 目标

1. **新增一个 Agent 工具**，让模型可以在当前会话里请求「重启应用与 Host」，并在请求里描述重启之后要做什么。
2. **重启后自动续作**：重启那一瞬间正在回合中的根会话，开机后自动收到一条续作指令并继续干活（不重做已完成的工作）。
3. **自定义重启后任务**：调用方可以附带一组任务，重启后在指定会话或新会话里执行。
4. **可观测、可撤销、幂等**：计划文件、回执、日志；重启失败不产生半执行状态；重复执行不重复投递。
5. 保留现有按钮路径，并让它和工具走**同一条**重启流水线（同一份计划格式、同一套门禁）。

非目标（明确不做）：

- 不改 `app.asar`、不加 Electron IPC，重启仍走 `relaunch.mjs` 那条**打包版唯一可用**的路径。
- 不支持 `dsh web` / CLI（工具返回 `desktop-only`；后续再评估 host 自重启用）。
- 不做「重启前优雅收尾回合再重启」（见 §12 P2）。

## 2. 现状与缺口（v0.3.0）

现有链路：按钮 → `POST /dsh-harness-restart/restart` → `relaunch.mjs`（杀壳前启动、ready 门禁）→ `process.kill(ppid)` → 壳死 → 助手用 `explorer.exe` 拉起应用。

缺口：

| # | 缺口 | 后果 |
| --- | --- | --- |
| G1 | 没有 Agent 工具，只有人点按钮 | 模型无法「重启后继续」 |
| G2 | 杀壳前不 flush 会话 | 最后几步可能没落盘（靠 checkpoint 兜底，不保证） |
| G3 | 没有任何「重启后」动作 | 被中断的会话停在半截，需要人手动再发一句 |
| G4 | 没有计划/回执 | 无法回答「重启后干了什么」 |
| G5 | 路由无参数 | 按钮无法表达「重启后继续」或自定义任务 |

## 3. 总体设计

一条流水线，两个入口：

```
入口 A：Agent 工具 harness_restart(...)       入口 B：标题栏按钮 POST /restart
                └──────────────┬──────────────────────┘
                               ▼
                  ① 组装计划（resume 候选 + tasks）→ 原子落盘
                               ▼
                  ② 启动 relaunch.mjs 并等 ready 标记（门禁，失败则回滚计划、报错）
                               ▼
                  ③ 工具返回 / 路由回 202  ← 结果先落进会话日志
                               ▼
                  ④ 延迟 ~1.5s：flush 所有活会话 → process.kill(ppid) 杀壳
                               ▼
                         应用重启（explorer 拉起，沿用 v0.3.0）
                               ▼
                  ⑤ 新 Host 启动 → 插件 apply() → 恢复引擎读计划
                               ▼
                  ⑥ 逐个投递：续作指令 / 自定义任务（stagger，幂等）
                               ▼
                  ⑦ 回执写盘（history.jsonl）→ 客户端可读 /status 展示
```

关键点：**④ 延迟执行**。工具必须先把结果返回、让工具结果进入会话日志并 flush，再杀进程；否则模型永远看不到这次调用的结果。

## 4. 计划文件（durable）

### 4.1 位置

```
$DSH_HOME\harness-restart\
  plan.json          # 当前待执行计划（原子写：tmp + fsync + rename）
  history.jsonl      # 追加式回执（最近 N 条由读取端截断）
  restart.lock       # 单次重启互斥锁（O_EXCL；持有者进程已死可被新 Host 接管）
```

`DSH_HOME` 缺失时退回 `os.homedir()/.dsh`。日志（`restart.log`、`launch-N.*.log`）继续放 `%TEMP%\dsh-harness-restart\`，**计划与回执不放 temp**（temp 会被清理，而计划必须在重启后仍然存在）。

### 4.2 结构

```jsonc
{
  "version": 1,
  "planId": "rst-20261109T140112-3f2a",
  "createdAt": 1762660872000,
  "origin": "tool",              // tool | button
  "reason": "加载新插件代码",
  "requestedBy": {               // 调用方（工具路径）
    "sessionId": "session-…",
    "cwd": "D:\\codeSpace\\js",
    "agentPreset": "standard"
  },
  "resume": [                    // 重启后要续作的会话
    {
      "sessionId": "session-…",
      "cwd": "D:\\codeSpace\\js",
      "agentPreset": "standard",
      "openTurnStartSeq": 812,   // 重启瞬间的开放回合，写下来便于排查
      "lastTurn": 41,
      "continuationHint": "把刚才的重构收尾",   // 可选，调用方补充
      "state": "pending"         // pending | delivered | skipped | failed
    }
  ],
  "tasks": [                     // 重启后要执行的自定义任务
    {
      "id": "task-1",
      "prompt": "跑一遍 npm test 并把失败摘要贴出来",
      "title": "重启后跑测试",     // 可选，会用于会话标题
      "target": "new",            // new | session
      "sessionId": null,
      "cwd": "D:\\codeSpace\\js",
      "agentPreset": "standard",
      "notBefore": null,          // 可选 ISO 时间
      "state": "pending"
    }
  ],
  "policy": { "resume": "interrupted", "maxResumeSessions": 8, "staggerMs": 800 },
  "state": "armed",              // armed | restarting | executing | done | failed | expired | aborted
  "expiresAt": 1762664472000     // created + planTtlMinutes（默认 60）
}
```

状态机（实现版）：

- `armed`：计划已落盘、助手未就绪。**不可执行**；进程死在这一步，下次启动会把计划标 `aborted`。
- `restarting`：助手已就绪、停壳已安排；新 Host 唯一会执行的入口。
- `executing`：恢复中；中途再挂，下次启动继续（固定 `requestId` 去重）。
- `done`：所有条目终态；若仍有 `at` 未到的任务则保持 `executing`，到点再跑。

不变量：

- 一个时刻最多一个 `plan.json`；已有未过期且 `state` 属于 `armed|restarting` 的计划时，新请求返回 `plan-busy`（或按调用方 `replace: true` 覆盖——v1 不做，避免打架）。
- `state` 只由持锁者推进；写入顺序：先 `armed`，杀壳前 `restarting`，开机执行时 `executing`，全部结束 `done`。
- 计划里**不写 prompt 全文到日志**，只写 id 与长度；`plan.json` 本身包含用户 prompt（本地文件，权限同用户目录）。
- 过期（`now > expiresAt`）的计划在开机时标 `expired` 并**不执行**，避免用户隔天手动开应用被意外续作。

### 4.3 回执

`history.jsonl` 每行一条（JSON），示例：

```json
{"type":"plan","planId":"rst-…","at":1762660872000,"resume":2,"tasks":1}
{"type":"resume","planId":"rst-…","sessionId":"session-…","status":"delivered","messageRequestId":"restart-rst-…-1","at":1762660901000}
{"type":"task","planId":"rst-…","taskId":"task-1","sessionId":"session-新","status":"delivered","at":1762660902000}
{"type":"plan-done","planId":"rst-…","ok":true,"at":1762660904000}
```

客户端 `GET /dsh-harness-restart/status` 读最近一条 plan 回执 + 版本/能力位，用于「重启完成：已恢复 N 个会话，已启动 M 个任务」提示。

## 5. 工具设计

命名空间 `harness_restart*`（已确认现有 86 个工具中无冲突）。三个工具，均注册在 Host 根的 tools 作用域（同 `dsh-memory` 的做法，profile 级 patch 行即可对全部 Agent 可见）。

### 5.1 `harness_restart`

```jsonc
{
  "type": "object",
  "properties": {
    "reason": { "type": "string", "description": "为什么要重启（会写进计划和日志，便于事后复盘）。" },
    "resume": {
      "type": "string",
      "enum": ["interrupted", "self", "none"],
      "description": "重启后恢复哪些会话。interrupted=重启瞬间处于回合中的根会话（默认）；self=只恢复本会话；none=不恢复。"
    },
    "sessions": {
      "type": "array",
      "items": { "type": "string" },
      "description": "显式恢复这些会话 id（给定时覆盖 resume）。"
    },
    "continuation": { "type": "string", "description": "给被恢复会话的额外续作提示（会拼进续作指令，可省略）。" },
    "tasks": {
      "type": "array",
      "description": "重启后要执行的任务。",
      "items": {
        "type": "object",
        "properties": {
          "prompt": { "type": "string", "description": "任务内容。" },
          "title": { "type": "string", "description": "新会话标题（可选）。" },
          "newSession": { "type": "boolean", "description": "true=开新会话（默认），false=发到 sessionId 指定的会话。" },
          "sessionId": { "type": "string", "description": "newSession=false 时的目标会话。" },
          "cwd": { "type": "string", "description": "新会话的工作目录（默认与本会话一致）。" },
          "agentPreset": { "type": "string", "description": "新会话的预设（默认与本会话一致）。" },
          "at": { "type": "string", "description": "可选，不早于该 ISO 时间执行。" }
        },
        "required": ["prompt"]
      }
    },
    "dryRun": { "type": "boolean", "description": "true=只写计划并回报将发生什么，不重启。" }
  },
  "required": []
}
```

返回（也是给模型看的最后一条证据）：

```json
{
  "ok": true,
  "planId": "rst-…",
  "restarting": true,
  "restartInMs": 1500,
  "willResume": [{ "sessionId": "session-…", "title": "…" }],
  "tasks": [{ "id": "task-1", "target": "new", "promptBytes": 96 }],
  "note": "约 1.5 秒后重启；重启完成后本会话会自动收到一条续作指令，无需再次调用本工具。"
}
```

错误码（`ok:false` + `code`）：`desktop-only`、`nested-agent`（子智能体调用）、`plan-busy`、`relaunch-unavailable`（助手没 ready，**什么都没杀**）、`shell-alive`、`not-approved`、`approval-unavailable`（没有应答者，失败关闭）、`invalid-argument`、`store-failed`、`internal`。

**确认（审批）**：默认 `requireApproval: true`，工具体内先调
`ctx.approval.request({ agent: exec.agent, toolName: 'harness_restart', callId: exec.callId, reason })`：

- `allowed-once` → 继续；
- `rejected` / `cancelled` → 返回 `not-approved`，不写计划；
- `unavailable`（无应答者，例如非交互 profile）→ 继续执行（本插件本来就只在桌面交互环境有重启能力），并在结果里注明。

### 5.2 `harness_restart_status`

只读：当前计划摘要、最近一次完成的重启、仍未完成的条目。返回：

```json
{
  "ok": true,
  "active": true,
  "plan": "rst-… · 状态 executing · 恢复 1/2，任务 0/1 · 创建于 …",
  "last": "rst-… · 完成于 … · 恢复 2 个会话、启动 1 个任务",
  "unfinished": ["resume:session-…:failed", "task:task-1:pending"]
}
```

`plan` / `last` 用字符串而不是嵌套对象：输出 schema 保持扁平，避免不同 Host 版本对 schema 关键字的支持差异。

`interrupted` 的判定：宿主启动后，对 `sessionController.list()` 里 `running === false` 且**日志尾部是未闭合回合**的会话做一次抽样（见 §6.3 的可选增强；v1 只列计划里记录过但未恢复的条目）。

### 5.3 `harness_restart_cancel`

删除/作废当前 `armed` 计划（`restarting` 之后不可撤销）。返回 `{ ok, cancelled: true|false, planId? }`。

## 6. 重启后恢复引擎（boot runner）

### 6.1 何时跑

`apply()` 里挂一个延迟任务（约 1.5–2s，让 Host 的 web/模型/存储都就绪；用 `ctx.timer.timeout`，随插件卸载自动取消）：

1. 读 `plan.json`；没有则退出。
2. 状态机校验：`armed`/`restarting`/`executing` → 继续；`done`/`expired`/`aborted` → 退出；`createdAt` 早于 TTL → 标 `expired` 退出。
3. 等 `sessionController` 可用（最多 20 次 × 1 秒；仍不可用就把计划留给下次启动）。
4. 先把 `state` 改成 `executing` 再开始投递，逐条写回 `plan.json`（同一计划重跑时，已投递条目因状态与固定 `requestId` 而不会重复）。

### 6.2 续作投递（核心）

对每条 `resume` 条目：

```js
// 1) 幂等标识：同一计划同一条目永远同一个 requestId
const requestId = `restart-${planId}-${entry.sessionId}`
// 2) 这条 API 会自己完成：恢复冷会话 → 建 agent → 建 user/message → followup
//    （sessionController.prompt 内部走 resolveAgent，并按 requestId 去重）
await ctx.sessionController.prompt({
  sessionId: entry.sessionId,
  requestId,
  mode: 'queue',                       // queue → followup（新回合）
  content: [{ type: 'text', text: continuationText(entry, plan) }],
}, signal)
// 3) 只记“已接受”，不再等回合跑完
```

要点：

- 用 `ctx.sessionController.prompt` 而不是自己拼消息：它负责 resume、`user-rpc` 来源、按 `requestId` 去重、附件/文件回执校验，且 agent 的生命周期归 Session Controller（不会随本插件卸载而析构）。
- `mode: 'queue'` → `agent.followup(...)`：空闲则立刻起回合，忙则排在下一回合；不会打断用户正在输入的内容。
- 失败分类：`session/not-found`、`session/agent-busy`（子代理会话）、`session/writer-held`、`gateway/internal` → 记录回执并继续下一条；本条目 `failed`，不阻塞其它条目。

### 6.3 续作指令文案

`lib/text.js` 里生成，中英双语（跟随应用语言，默认中文）：

```
[harness-restart] 宿主刚刚完成一次重启（{时间}，原因：{reason|未知}）。
本会话在重启时被中断，日志里的最后一步可能停在半途（工具结果被标记为中断）。

请按以下顺序继续：
1. 用一两句话说明重启前的进度、下一步要做什么（日志里已有，不要要求我复述）。
2. 从最后一个检查点继续执行；已完成的工作不要重做，没跑完的命令重新跑。
3. 如果原任务其实已经完成，直接说明并等待我的下一条指令。
{4. 本次重启还排队了这些任务：{tasks 摘要}}

除非我明确要求，不要再次调用 harness_restart。
```

`{reason}` 只在工具路径存在；按钮路径写「用户点击了重启」。

### 6.4 自定义任务投递

对每条 `tasks`：

- `target: new`：
  ```js
  const { sessionId } = await ctx.sessionController.create({
    cwd: task.cwd ?? plan.requestedBy.cwd,
    agentPreset: task.agentPreset ?? plan.requestedBy.agentPreset,
  })
  if (task.title) ctx.sessionController.rename({ sessionId, title: task.title })   // 失败不致命
  await ctx.sessionController.prompt({ sessionId, requestId: `restart-${planId}-${task.id}`, mode: 'queue',
    content: [{ type: 'text', text: task.prompt }] }, signal)
  ```
- `target: session`：直接对 `task.sessionId` 走 §6.2 的 `prompt`。
- `notBefore` 未到的任务保持 `pending`，用 `ctx.timer.timeout` 到点再投；进程重启后仍在计划里（下次开机继续等）。

### 6.5 限流与顺序

- 上限 `maxResumeSessions`（默认 8）：按「调用方会话优先 → 其余按最近活动」取前 N，其余标 `skipped` 并在回执里说明。
- 每条之间 `staggerMs`（默认 800）错峰，避免开机瞬间并发十几个模型请求。
- 跳过 `workspaceRegistry.archivedSessionIds` 里的归档会话。
- 全部条目结束后 `state: 'done'`，进度百分比可在 `plan.json` 里查到。

### 6.6 与按钮路径共用

`POST /restart` 也组装计划：`origin: 'button'`、`resume` 取配置默认（默认 `interrupted`）、`tasks` 为空（P1 支持 UI 里填写）。这样「点按钮重启 → 被中断的会话照样续作」，不需要用户理解两套东西。

## 7. 重启执行（对现有代码的改造）

把 `index.js` 里的 `startAssistant/stopShell/restart` 抽到 `lib/restart.js`，并加两步：

1. **冲刷**：杀壳前 `for (const s of ctx.sessions.list()) await ctx.sessions.flush(s)`，整体加超时（例如 3s），失败只记日志、不阻塞重启（落盘保底仍由 checkpoint 策略负责）。
2. **延迟杀壳**：工具/路由**先返回**，再由定时器（`restartDelayMs`，默认 1500）执行「flush → 杀壳」。若杀壳失败 → 计划标 `aborted` 并写回执（保证不会在下次正常启动时莫名续作）。
3. 助手 `relaunch.mjs` 增加两个可选参数（`planDir`、`planId`），失败时写一条 `launch-failed` 回执；行为不变。
4. 现有 `pending` 布尔换成同一把文件锁，避免「按钮 + 工具」同时触发。

## 8. 客户端（P1，可与 P0 一起发）

- 确认气泡增加两项（都可折叠，默认不打扰）：
  - `☑ 重启后继续被中断的会话`（默认开，对应 `resume: interrupted`）
  - `重启后执行的任务（可选，每行一条）` → `tasks: [{ prompt }]`
- 挂载时 `GET` 同一路由：若最近一次计划在 10 分钟内完成，显示一行可关闭的提示「已恢复 N 个会话 / 已启动 M 个任务」。
- 版本握手升级：`GET` 返回 `{ version, supported, capabilities: ['restart','resume','tasks'], resumeDefault, maxTasks, lastPlan }`；`resumeDefault` 预选气泡开关，`maxTasks` 限制任务行数，`lastPlan` 供完成提示。
- 客户端快照机制不变：改 `client.js` 后仍需要重开一次应用才能看到新 UI（这是 harness 的既有约束，文档里已写明）。

## 9. 配置

`cordis.patch.yml` 保持 `- insert: [... config: {}]`，键由代码默认值兜底；另在 README 列全部键：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `resume` | `"interrupted"` | 按钮路径的默认恢复策略（`tool` 路径以调用参数优先） |
| `requireApproval` | `true` | 工具路径是否走 `ctx.approval` |
| `maxResumeSessions` | `8` | 单次恢复上限 |
| `staggerMs` | `800` | 续作投递间隔 |
| `restartDelayMs` | `1500` | 工具返回后延迟多久杀壳 |
| `planTtlMinutes` | `60` | 计划过期时间 |
| `continuationLanguage` | `"auto"` | `auto` / `zh` / `en` |
| `flushTimeoutMs` | `3000` | 杀壳前 flush 的超时 |
| `storeDir` | `null` | 覆盖 `$DSH_HOME/harness-restart` |

## 10. 文件与改动清单

```
index.js                 改：apply() 改为 ① 注册工具 ② 注册路由（GET/POST）③ 启动恢复引擎
lib/config.js            新：VERSION、路由常量、配置默认值与钳制
lib/restart.js           新：桌面判定、助手启动/ready 门禁、flush、延迟停壳、requestRestart、任务规整
lib/plan.js              新：计划读写（原子写、锁、状态机、TTL、回执、最近回执摘要）
lib/policy.js            新：resume 参数规整 + 重启瞬间活会话快照 + 选择（纯函数）
lib/resume.js            新：恢复引擎（逐条投递、stagger、错误分类、幂等、未来任务重排）
lib/tools.js             新：三个工具定义 + output schema + render + 审批
lib/text.js              新：续作指令 / 工具结果 / 错误码文案（zh/en）+ 语言探测
client.js                改：恢复开关、任务输入框、完成提示、能力位/不支持分支
relaunch.mjs             改：planDir/planId 参数 + relaunch-ok/failed/abandoned 回执
cordis.patch.yml         不变（保持 config: {}）
package.json             改：version 0.4.0、files 加 lib/、check/test 脚本
locale/zh.json, en.json  改：meta 文案
test/plan.test.mjs       新
test/policy.test.mjs     新
test/text.test.mjs       新
test/resume.test.mjs     新（假 sessionController 跑恢复引擎）
test/tools.test.mjs      新（工具定义、审批、守卫顺序、status/cancel）
test/smoke-client.mjs    改：版本号、新控件、旧/不支持 Host、完成提示
docs/mechanism.md        改：新增「重启后恢复」一节与时序、排错表
README.md / README.en.md 改：工具、配置、行为
CHANGELOG.md             改：0.4.0
```

## 11. 已验证的 API（实现依据）

| 用途 | API | 依据 |
| --- | --- | --- |
| 恢复冷会话并投递消息 | `ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue'\|'steer', content: [{type:'text',text}] }, signal)` | 实时 Service 目录 + `session-controller/src/{index,commands}.ts`：内部 `resolveAgent` 后 `followup/steer`，按 `requestId` 去重 |
| 建新会话 | `ctx.sessionController.create({ cwd? \| workspaceId?, agentPreset? })` → `{ sessionId, agentPreset? }` | 同上（`SessionCreateRequest`） |
| 列会话 | `ctx.sessionController.list({}, signal)` → `items[]`，含 `running`/`blank`/`cwd`/`parentSessionId` | 实时目录 |
| 设置会话标题 | `ctx.sessionController.rename({ sessionId, title })` | 实时目录 |
| 判定「回合中」 | `ctx.agents.roots()` + `ctx.agents.turnBoundaryOf(session).openTurnStartSeq !== null` | 实时目录（`TurnBoundaryProjection`） |
| 会话落盘 | `ctx.sessions.flush(session)` | 实时目录 |
| 审批 | `ctx.approval.request({ agent, toolName, callId?, reason })` → `'allowed-once'\|'rejected'\|'cancelled'\|'unavailable'` | 实时目录 + `user-approval/src/types.ts` |
| 工具注册 | `ctx.tools.register({ name, description, parameters, output: { schema, render? }, timeoutMs?, async execute(args, exec) })`，`exec.agent` / `exec.callId` / `exec.signal` | 本机在跑的 `dsh-memory/lib/tools.js`（同款 harness 上已验证可用） |
| 归档集合 | `ctx.workspaceRegistry.archivedSessionIds` | 实时目录 |
| 宿主判定 | 现有 `desktopHost()`（`process.versions.electron` + `process.ppid`） | 项目现有代码 |

**重要约束**：profile 的 `node_modules` 里**没有** `@deepseek-ai/*`（只有 `cosmokit`、`schemastery`），第三方插件不要 `import '@deepseek-ai/…'`。全部通过 `ctx.*` 服务与纯对象完成——本方案不需要任何 harness 包导入。

## 12. 里程碑

**P0（0.4.0，核心）**

1. `lib/plan.js` + `lib/text.js` + `lib/restart-policy.js`（纯逻辑，先写单测）。
2. `lib/tools.js`：`harness_restart` / `harness_restart_status` / `harness_restart_cancel` + 审批。
3. `lib/restart.js`：抽出现有重启流程，补 flush + 延迟杀壳 + 失败回滚计划。
4. `lib/resume.js`：boot runner（续作 + 任务 + stagger + 回执）。
5. `index.js` 接线；路由升级（`origin:'button'`、`/status`、能力位、版本 0.4.0）。
6. 测试 + 文档 + CHANGELOG。

**P1（体验）**：按钮气泡两项（恢复开关 + 任务输入框）、重启完成提示、`/status` 展示。

**P2（进阶，另开一轮）**：

- `when: 'after-turn'`：当前回合自然结束后再重启（调用方会话无需续作，其余照样恢复）。
- 开机扫描「所有」尾部未闭合的会话（不只计划内），提供「一键恢复上次中断」。
- `dsh web`/CLI 的 host 自重启（同一端口自拉起，页面可重连——harness 已有 server-restart e2e 证明可行）。

## 13. 测试与验收

**单测（`node --test`，无需 harness）**

- 计划：编码/解码、原子写、TTL、状态机非法转换、锁互斥与陈旧锁回收、回执追加与摘要、历史裁剪。
- 策略：给定活会话集合（含子代理、归档、无开放回合）与不同 `resume` 参数 → 期望子集；上限截断顺序；`self`/`none`/显式数组；`turnBoundaryOf` 缺失时退回 `turnBoundary` 投影、再退回 `Agent.status`。
- 文案：zh/en、含/不含 reason、含/不含 tasks。
- 恢复引擎（假 sessionController）：投递参数（`requestId` 稳定、`mode:'queue'`）、错误码分类、stagger、幂等（同一计划跑两次只投一次）、`at` 未到保持 pending、`armed` 计划不执行、过期计划不执行。
- 工具：定义与 schema、审批开关与四种结局、守卫顺序（子智能体→参数→桌面端）、status/cancel（含「取消要拿锁」）。
- 助手：参数解析（坏 pid → unknown）、进程表解析（列精确匹配）、拉起判定（未知不重复启动）。
- Host 入口：路由/工具挂载、GET 握手字段、POST 鉴权与 `desktop-only`、诊断路由的 header 闸、两半 `VERSION` 一致。
- 客户端冒烟：默认请求只发一次（双击）、取消勾选 → `resume:'none'`、Host 的 `maxTasks` 截断、请求被拒后控件可用、旧/不支持 Host、完成提示。

**手工 E2E（真机，本会话即测试对象）**

1. 装 0.4.0（link 已存在，改代码即可）→ **手动重开一次应用**（Host 与 client bundle 都靠启动加载）。
2. 开一个会话，让模型调 `harness_restart`，带一条任务，例如「重启后检查 `%TEMP%\dsh-harness-restart\restart.log` 并汇报」。
3. 观察：审批卡 → 工具结果（restarting）→ 应用重启 → 本会话自动收到续作指令并继续 → 新任务会话启动 → `plan.json` 状态 `done` + `history.jsonl` 回执。
4. 负例：伪造 `%TEMP%` 不可写 / 助手起不来 → 工具返回 `relaunch-unavailable`，应用不重启，计划被回滚。
5. 负例：过期计划（把 `expiresAt` 改到过去）→ 开机不执行，标 `expired`。

**代码审查**：按你的既有要求，实现完成后另起一个独立子智能体做一次代码审查再交付。

## 14. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 工具结果还没落盘就被杀 | 延迟杀壳（1.5s）+ 杀前 flush；结果里明确「重启后会自动续作」 |
| 重启后模型连发请求、烧 token | 上限 + stagger + TTL + 续作文案禁止二次重启 |
| 计划在下次正常启动被误执行 | TTL + 状态机 + `aborted` 回滚；只有 `armed/restarting` 才执行 |
| 重复投递 | `requestId` 稳定（`restart-<planId>-<entry>`），`sessionController.prompt` 去重 |
| rc.5 与源码 rc.2 有差异 | 本方案的 API 都取自**运行中**的 Service 目录；实现时再逐条核对签名 |
| 拉不起来 | 计划保留到 TTL，用户手动启动后仍会恢复 |
| 新会话没进工作区分组 | `create()` 传 `cwd`（harness 按目录分组）；需要更准时可先 `workspaceRegistry.resolveByPath(cwd)` 再传 `workspaceId` |
| 插件被重载时重复跑 runner | 文件锁 + 内存标志 + 幂等 requestId |
| `DSH_SHELL` 等环境变量污染 | 不读这些变量判断环境；用 `desktopHost()` |

## 15. 已确认的决定

1. **默认恢复范围**：`interrupted` —— 重启瞬间处于回合中的所有根会话。
2. **工具审批卡**：保留（`requireApproval: true`，`ctx.approval` 返回 `rejected`/`cancelled` 才拒绝，`unavailable` 放行）。
3. **按钮也加自定义任务**：气泡里同时提供恢复开关与任务输入框（P1 一并交付）。
4. **续作文案语言**：跟随对话语言（`continuationLanguage: auto`，可强制 `zh`/`en`）。
5. **交付**：本地提交，沿用仓库作者 `githublmk`，不推送远端。
