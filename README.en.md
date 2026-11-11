# dsh-harness-restart

A **Restart** control and a **restart tool** for the DeepSeek Harness Desktop: restart the app and its Host after a confirmation, then have the interrupted Sessions continue automatically, with optional tasks queued for after the restart.

> The Desktop Application menu is a native Electron menu. Its "Restart App and Host" item is gated behind `development` in `applicationItems()`, and a Cordis plugin cannot add items to a native menu. This bundle therefore puts its own restart entry on the same menu bar and exposes the same capability to Agents as tools.

## What you get

- **Caption-band button** — right after the panel nav's overflow ("更多"). Its confirmation popover offers "Continue interrupted Sessions after the restart" (on by default) and a "Post-restart tasks" box, one task per line.
- **Agent tools** — `harness_restart`, `harness_restart_status`, `harness_restart_cancel`.
- **Automatic continuation** — every root Session that was inside a turn at the moment of the restart **and the subagents it was running** receives its own continuation instruction afterwards and continues from its last checkpoint without redoing finished work. A subagent is cold-resumed by its parent Session and sends its result back with `send_message`.
- **Post-restart tasks** — each runs in a new Session (cwd / preset / title / `at` configurable) or in a named Session.
- **Observability** — the plan, per-entry receipts, and failure reasons live on disk; the page reports "N Session(s) resumed, M task(s) started" once it is back.

## The button

- Desktop only: the panel nav must sit in the caption band (the `dsh-panel-titlebar` layout), or `[data-windows-menu]` must be at the top. A plain browser page never shows it.
- Positioned 8px right of the overflow launcher, re-measured every second, hidden when the window has no room left of the native window controls.
- A confirmation popover (`Esc` or click-away closes it), then the control reads "正在重启…".
- Bilingual (zh / en), following the app language.

## The tools

| Tool | Purpose |
| --- | --- |
| `harness_restart` | Request one restart. Arguments: `reason`, `resume` (`interrupted` default / `self` / `none`), `sessions[]`, `continuation`, `tasks[]`, `dryRun`. `continuation` is the calling Session's own instruction for its next turn; it is never copied into another Session's continuation. |
| `harness_restart_status` | Read the current plan, the last finished restart, and unfinished entries. |
| `harness_restart_cancel` | Drop a plan that has not reached the shell-stop stage yet (`armed`). |

`harness_restart` asks the Agent approval service first (disable with `requireApproval: false`). Without an answerer it refuses with `approval-unavailable` instead of restarting unasked, and only a root Session may call it (a subagent gets `nested-agent`). After approval it writes the plan, starts the relaunch assistant, returns its result, and stops the shell about 1.5 s later — the delay exists so the tool result reaches the Session log before the process dies. Failures return `{ ok:false, code, message }` with `desktop-only`, `plan-busy`, `relaunch-unavailable`, `shell-alive`, `not-approved`, `approval-unavailable`, `continuation-without-self`, or `invalid-argument`.

## How the continuation works

1. Before the restart, the plan records every live root Session whose turn is open **and the subagents running under them** (`agents.roots()` plus `agents.list()`, with `turnBoundaryOf(session).openTurnStartSeq` deciding whether a Session is inside a turn; subagents carry `parentSession` and `delegationDepth`). Turns that ended or were deliberately stopped are not selected.
2. About 1.5 s after the next Host boots, the plan is delivered parents first (roots, then shallow children, then deeper ones):
   - a root receives `sessionController.prompt({ sessionId, requestId: 'restart-<planId>-<session>', mode: 'queue', content: [continuation] })`, which resumes the cold Session, rebuilds its Agent, appends the user message, and follows up;
   - a subagent receives `subagents.prompt({ requestId, parentSessionId, childSessionId, mode: 'continuable', delivery: 'queue', content: [continuation] })`. A child is never prompted directly: the Host only continues it from its **live direct parent**, so that parent has to be resumed first. When the parent had no open turn (a lead that stopped while a teammate ran), it is revived on its own with `agents.resume` so it can receive the child's result. A child whose parent cannot be revived, or one that is not continuable (one-shot), is recorded as `skipped` and never retried.
3. The instruction states the restart, asks for a short status recap, forbids redoing finished work, tells a subagent to return its result to the parent with `send_message`, and forbids another restart unless the user asks for one. A root is also told which of its restarted children are running on their own, so it does not re-delegate the same work.
4. Only the Session that requested the restart can customise its own next move: `continuation` is attached to that Session's entry alone, and every other resumed Session (subagents included) gets the standard instruction. Supplying `continuation` while that Session is not being resumed (`resume: 'none'`, or `sessions` without it) fails with `continuation-without-self` instead of restarting with a hint nobody would read.
5. Delivery is idempotent for roots: the `requestId` is stable per entry and `prompt` dedupes on it; the plan is written after every entry, so a second death only delivers what is missing. A child goes through `subagents.prompt`, which has no `requestId` dedupe, so a death in the instant between "child accepted" and "plan written" can deliver that one child twice (see Limitations).
6. Bounds: `maxResumeSessions` (8, counting roots and subagents together), `staggerMs` (800), `planTtlMinutes` (60). The tool's `note` promises a continuation only to a Session the plan actually resumes, and counts the subagents it includes.

## How the restart works

See [docs/mechanism.md](docs/mechanism.md). Short version:

The Host is a child process of the Electron shell and `dsh-desktop-host` shuts itself down on `process.disconnect`, so the Host cannot survive the shell it just stopped. `relaunch.mjs` is started **before** the shell is stopped (detached, no pipes); it waits until the shell and the Host are gone, then starts the application the way a double click does (`explorer.exe <app exe>`), and verifies through the process table that it stayed alive. Failures are retried and then fall back to a direct launch.

Safety property: **the shell is never stopped without a ready relaunch assistant**; a failed stop marks the plan `aborted`, so a later normal start cannot surprise anyone. The executable path comes from the running Host's `process.execPath`.

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

## Configuration

Every key is optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `resume` | `interrupted` | Button-path resume policy; also preselects the switch when the popover opens |
| `requireApproval` | `true` | Use the Agent approval service for the tool |
| `maxResumeSessions` | `8` | Sessions continued after one restart |
| `staggerMs` | `800` | Pause between two continuation prompts |
| `restartDelayMs` | `1500` | Delay between the tool result and the shell stop |
| `planTtlMinutes` | `60` | A plan older than this is never executed |
| `continuationLanguage` | `auto` | `auto` follows the conversation; `zh` / `en` force |
| `flushTimeoutMs` | `3000` | Budget for flushing live Sessions before the kill |
| `bootDelayMs` | `1500` | Wait after boot before restoring |
| `maxTasks` | `8` | Tasks per plan (also the most task lines the popover accepts) |
| `storeDir` | `null` | Override the plan directory (default `$DSH_HOME/harness-restart`) |

### Turning the tool approval off (optional)

When the Session's approval policy is `never`, no card can appear and the tool fails closed with `not-approved` (`approval-unavailable` when no answerer exists); with `requireApproval: true` it therefore cannot restart. To let the tool restart directly, override the row in the **profile's** `cordis.patch.yml`:

```yaml
- id: harness-restart
  config:
    requireApproval: false
```

The tradeoff is that the model may restart the app without a card (the caption-band button is unaffected: it has its own confirmation). With `patchReload: live` the change usually applies within seconds; otherwise on the next start.

## Data and logs

Plans and receipts: `$DSH_HOME\harness-restart\` — `plan.json` (atomic tmp+fsync+rename; corrupt files are renamed `plan.json.corrupt-*`), `history.jsonl`, `restart.lock`.

Timeline logs: `%TEMP%\dsh-harness-restart\` — `restart.log`, `client-probe.log`, `launch-N.out.log` / `launch-N.err.log`.

## Limitations

- Windows Desktop only; other environments answer `409 desktop-only`.
- The restart stops the shell rather than running its graceful quit: running turns are interrupted and then continued by the plan; the interrupted step itself is not resumed in place (Harness crash recovery only closes the turn).
- Only a plan that reached `restarting` is delivered: an `armed` plan left behind by a Host that died before the assistant was ready is abandoned on the next start (`plan-abandoned`), never replayed.
- Live Sessions are flushed before the kill; a flush timeout is logged and never waited on forever (the plan still covers the interruption).
- The client bundle is an activation-time snapshot, so `client.js` changes need an application restart.
- In some environments the automatic launch can fail (the process starts, no window appears). The logs show it; the plan still runs on the next start while inside its TTL.
- The continuation really does start model turns; bound them with `maxResumeSessions` (roots and subagents together), or pass `resume: 'none'`.
- Only **continuable** subagents can be continued (the ones whose Session carries continuation state and that `send_message` can reach). A one-shot subagent, a child whose parent is archived, or one whose parent cannot be revived, is recorded as `skipped` (`subagent/not-resumable` / `subagent/parent-unavailable`) and never retried.
- An entry recorded as `failed` (for example `subagent/delivery-unavailable`, or any other transient error) keeps the plan `executing`, so the **next start retries it** until the plan expires (`planTtlMinutes`, 60 minutes by default). `skipped` entries are never retried.

## Development

```powershell
npm run check   # node --check for every entry and lib module
npm test        # plan/policy/text/restore unit tests + headless client smoke
```

## License

MIT
