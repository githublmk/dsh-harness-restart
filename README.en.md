# dsh-harness-restart

A **Restart** control for the DeepSeek Harness desktop caption band, right after the global panel nav's overflow ("更多"), restarting the app and its Host after a confirmation.

> The Desktop Application menu is a native Electron menu. Its "Restart App and Host" item is gated behind `development` in `applicationItems()`, and a Cordis plugin cannot add items to a native menu. This bundle therefore puts its own restart entry on the same menu bar.

## What you get

- Only in the Desktop app: the panel nav must sit in the caption band (the `dsh-panel-titlebar` layout), or `[data-windows-menu]` must be at the top. A plain browser page never shows it.
- Positioned 8px right of the overflow launcher, re-measured every second, hidden when the window has no room left of the native window controls.
- A confirmation popover (`Esc` or click-away closes it), then the control reads "正在重启…".
- Bilingual (zh / en), following the app language.

## How the restart works

See [docs/mechanism.md](docs/mechanism.md) for the details. Short version:

The Host is a child process of the Electron shell and `dsh-desktop-host` shuts itself down on `process.disconnect`, so the Host cannot survive the shell it just stopped. `relaunch.mjs` is started **before** the shell is stopped (detached, no pipes); it waits until the shell and the Host are gone, then starts the application the way a double click does (`explorer.exe <app exe>`), and verifies through the process table that it stayed alive. Failures are retried and then fall back to a direct launch.

The executable path comes from the running Host's `process.execPath`; nothing is hard-coded to an install directory, and the `tasklist` image name is derived from it.

Safety property: **the shell is never stopped without a ready relaunch assistant**. The worst case is a rejected request and an untouched app, never a stopped app with no way back.

## Install

```powershell
plugin_manager install_bundle D:\path\to\dsh-harness-restart
```

The patch inserts one row:

```yaml
- insert:
    - id: harness-restart
      name: 'dsh-harness-restart'
      config: {}
```

Restart the application once after installing: both halves load at application start.

## Logs

`%TEMP%\dsh-harness-restart\`: `restart.log` (restart timeline), `client-probe.log` (language sources as the page sees them), `launch-N.out.log` / `launch-N.err.log` (direct-launch attempts).

## Limitations

- Windows Desktop only; other environments answer `409 desktop-only`.
- The restart stops the shell rather than running its graceful quit: running turns are interrupted (session logs survive).
- The client bundle is an activation-time snapshot, so `client.js` changes need an application restart.
- In some environments the automatic launch can fail (the process starts, no window appears). The logs show it; the fallback is a manual double click.
- The client checks the Host version first, so mismatched halves never take the restart path.

## License

MIT
