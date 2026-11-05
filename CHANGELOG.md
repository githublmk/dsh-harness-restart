# Changelog

## 0.3.0

- 重启改由 `relaunch.mjs` 助手完成：在杀壳**之前**启动（`detached`、无管道），避免 `dsh-desktop-host` 的 `process.disconnect` 停机把「拉起应用」这一步一起带走。
- 助手优先用 `explorer.exe <应用 exe>`（双击等价路径）启动应用，并用 `tasklist` 轮询进程表确认应用进程出现且 4 秒后仍在；失败退回直接 spawn，最多 3 次。
- 应用 exe 取自运行中 Host 的 `process.execPath`，`tasklist` 的镜像名取自它的 `basename`，不写死安装目录。
- 安全门禁：助手写不出 ready 标记时请求直接 500，**壳不会被杀**。
- 客户端在弹确认框前先 `GET` 路由校验 Host 版本，不匹配则拒绝执行（防止新旧两半混用）。
- 客户端语言判定改为多源（locale 服务 → 文档 lang → `navigator.language`），并停用 `locale.bind()` 取值：client locale 快照的 `active` 是 `zh`，用 `zh-CN` 注册的词典查不到会退回英文。
- 新增 `client-probe.log`：客户端挂载时上报语言来源，便于定位文案问题。
- 新增 `docs/mechanism.md`（三堵墙、时序、排错表）、`README.en.md`、`test/smoke-client.mjs`、CI。

## 0.2.0

- 修掉客户端语言取错字段的问题（`LocaleSnapshot` 的字段是 `active`）。
- 增加确认气泡与失败文案；按钮位置改为跟随「更多」启动器实时测量。

## 0.1.0

- 首个版本：`shell.overlay` 里的重启按钮 + Host 侧重启路由。
- 重启最初交给 PowerShell 助手完成（后续废弃，见 0.3.0）。
