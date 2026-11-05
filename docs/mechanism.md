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

## 现在的时序

```
页面  ── POST /dsh-harness-restart/restart ──▶  Host
                                              │
                        1. spawn relaunch.mjs  │  (ELECTRON_RUN_AS_NODE=1 跑同一个 exe，
                           detached、无管道)    │   detached 让它的进程组独立)
                                              │
                        2. 等 ready 标记文件    │  (≤4s；失败换非 detached 再试一次)
                           ┌──────────────────┐ │
                           │ 没有标记 → 500，  │ │
                           │ 什么都不杀        │ │
                           └──────────────────┘ │
                                              │
                        3. process.kill(ppid)  │  ← 停掉 Electron main
                        4. 轮询确认壳消失       │
                                              │
        （Host 自己的 disconnect 停机开始）      │
                                              ▼
                            relaunch.mjs 轮询 shell/host 是否都消失（≤20s）
                                              │
                                  壳还活着 → 直接退出（绝不启动第二实例）
                                              │
                                    停 2.5s，让端口与单实例状态落定
                                              │
                        5. explorer.exe "<app exe>"   ← 双击等价：explorer 自己的环境与父进程
                                              │
                        6. tasklist 轮询进程表：应用进程出现、且 4s 后仍在
                           失败 → 直接 spawn 重试 3 次（5s 观察 + 3s 间隔）
                                              │
                                   写 restart.log，退出
```

关键点：**第 2 步的门禁**。助手先证明自己活着（写 ready 标记），Host 才动手；这保证「壳被杀掉但没人拉起应用」不可能发生。

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
{ "ok": true, "version": "0.3.0", "supported": true, "build": "relaunch-assistant" }
```

`version !== VERSION` 时不发重启请求，只提示「当前 Host 还是旧版本，先重开一次应用再试」。这条是为了防止 Host 侧还没加载新代码、客户端已经是新版时，用旧的（比如会静默失败的）重启路径。

## 语言解析

客户端文案不依赖 `ctx.locale.bind()`：client locale 快照里的 `active` 是 **`zh`**（不是 `zh-CN`），按 `zh-CN` 注册的词典查不到，会一路退回英文。现在的取值顺序是：locale 服务（`active`/`id`/`locale`）→ 文档上的 `lang`/`data-locale`/`data-language` → `navigator.language`，任一是 `zh*` 就走中文，否则 `en*` 走英文，都没有则中文。

## 排错表

| 日志 | 含义 | 处理 |
| --- | --- | --- |
| `host: assistant did not report ready` 且请求 500 | 助手没起来，壳没被杀 | 应用原样；看是否 `%TEMP%` 不可写 |
| `relauncher: shell is still running; not starting a second instance` | 杀壳没生效 | 检查是否有进程保护/权限问题 |
| `relauncher: shell launch produced no application process` | explorer 启动后进程表里没新增 | 兜底直接 spawn 已自动尝试，看 `launch-N.err.log` |
| `relauncher: launched through shell; application processes=N` | 成功 | 窗口应在几秒内出现 |
| `client-probe.log` 里 `resolved` 与界面语言不符 | 语言来源判定问题 | 看同一行的 `hints` |

## 未走完的路（后续计划）

- 自动拉起在部分环境下仍可能失败（进程活着但窗口不出现）。下一步打算改走桌面壳自带的恢复路径：让 Host 以 fatal 方式退出，由壳弹出 `重启 / 退出 / 禁用第三方插件` 对话框，用户点「重启」触发 `app.relaunch()`——这是整台机器上唯一被反复验证能可靠拉起的路径，代价是多一次弹窗点击。
- 或者给桌面壳补一个 IPC（需要改 `app.asar`，属于改应用本体，升级会被覆盖），让它成为一个真正的一等能力。
