# dsh-harness-restart

给 DeepSeek Harness 桌面端标题栏菜单条加一个 **重启** 按钮 —— 位置就在全局面板导航的「更多」后面，点一下（二次确认）重启「应用与 Host」。

> 桌面端「应用」菜单是 Electron 原生菜单，打包版里没有「重启应用与 Host」这一项（只有开发版有），插件也无法往原生菜单插项。这个 bundle 走另一条路，在菜单条上放一个自带的重启入口。

## 界面

- **只在桌面端出现**：要求面板导航位于标题栏（`dsh-panel-titlebar` 把侧栏导航搬进标题条的那种布局），或 `[data-windows-menu]` 位于顶部。普通浏览器页面（`dsh web`）不显示——那里的「重启」没有意义。
- **位置**：紧跟「更多」启动器（`[aria-haspopup]`）右缘 +8px，随侧栏折叠、语言切换、窗口宽度每秒重测；右侧留 168px 给窗口按钮，空间不够时自动隐藏。
- **交互**：点一下弹出确认气泡（`Esc` 或点空白关闭）：

  > 重启应用与 Host？
  > 正在进行的任务会被中断，界面会在几秒后自动恢复。
  > 　　　　　　　　　　　　　[取消] [重启]

  确认后按钮变成「正在重启…」。请求被拒时气泡重新打开并说明原因。
- **文案**：中英双语，跟随应用语言。

## 它是怎么重启的

完整说明见 [docs/mechanism.md](docs/mechanism.md)。一句话版本：

Host 是桌面壳（Electron main）的子进程，**壳一死 Host 就被 `disconnect` 事件带走**，所以 Host 不可能「杀壳之后再拉起应用」。真正的重启由 `relaunch.mjs` 完成——它在杀壳**之前**就启动（脱离父进程、无管道），等壳和 Host 都消失后，用**双击等价的方式**（`explorer.exe <应用 exe>`）把应用拉起来，并用进程表确认它真的活着；失败会重试，仍失败就退回直接启动。

安全性质：**拿不到助手的 ready 标记就绝不杀壳**。最差情况是「按钮报错、应用原样」，不会出现「壳被杀掉、应用起不来」。

应用的可执行文件路径取自运行中 Host 的 `process.execPath`，没有写死安装目录；`tasklist` 里的镜像名也从它取 `basename`。

## 安装

```powershell
# 在本机 profile 里安装（会 link 当前目录）
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

## 日志

都在 `%TEMP%\dsh-harness-restart\`：

| 文件 | 内容 |
| --- | --- |
| `restart.log` | 一次重启的完整时序：`host: assistant ready` → `host: shell gone` → `relauncher: shell launch: application processes before=0` → `launched through shell; application processes=6` |
| `client-probe.log` | 客户端挂载时上报的语言来源（`active` / `documentLang` / `navigatorLanguage`），排查文案问题用 |
| `launch-N.out.log` / `launch-N.err.log` | 直接启动尝试的 stdout/stderr（走 explorer 路径时不会产生） |

## 限制与已知问题

- **仅 Windows 桌面端**。其余环境路由返回 `409 desktop-only`。
- 重启是「停壳 + 拉起」，不走壳的优雅退出流程：**进行中的回合会被中断**（会话日志保留，重开后仍在）。
- 客户端 bundle 是 Host 激活时的内存快照，改 `client.js` **必须重开应用**，刷新页面不够。
- 自动拉起在个别环境里可能失败（进程起来、窗口不出现）。日志里能看出来，兜底就是手动双击启动；后续计划改走桌面壳自带的 `app.relaunch()` 恢复路径。
- 客户端会先 `GET` 同一路由校验 Host 版本，旧 Host（例如升级前加载的）会拒绝执行，避免用不匹配的两半走重启。

## 开发

```powershell
npm run check   # node --check 三个入口
npm test        # 无头 React 替身跑客户端：注册、文案、版本门禁、POST、旧版本拒绝
```

`test/smoke-client.mjs` 用最小 React 替身和假标题栏 DOM 跑真实的 `client.js`，不需要浏览器。

## License

MIT
