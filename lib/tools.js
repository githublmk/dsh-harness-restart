/**
 * Model-facing tools of the harness-restart bundle.
 *
 * Three tools, all registered in the mounting scope, so a profile-level row
 * gives every Agent the same restart capability:
 * - `harness_restart` requests one restart and describes what happens after it;
 * - `harness_restart_status` reads the plan and the last finished restart;
 * - `harness_restart_cancel` drops a plan that has not started.
 *
 * The restart itself runs through the same Host path as the caption-band
 * button, so both entries share one plan format, one lock, and one gate.
 *
 * @module dsh-harness-restart/lib/tools
 */
import {
  acquireLock, appendReceipt, clearPlan, formatTime, isActive, isExpired, readPlan, recentPlanSummary, STATE,
  summarizePlan,
} from './plan.js'
import { normalizeResumeMode } from './policy.js'
import { desktopHost, normalizeTasks, requestRestart } from './restart.js'
import { errorText, languageFromSession, restartNote } from './text.js'

/** Tool name shared with the approval audit. */
const RESTART_TOOL = 'harness_restart'

/** Approval card text, keyed as the Agent approval service expects. */
const APPROVAL_DISPLAY = {
  en: 'Restart the app and Host now? Running turns are interrupted and continue automatically after the restart.',
  zh: '现在重启应用与 Host？进行中的回合会被中断，重启后会自动继续。',
}
const APPROVAL_REASON = {
  en: 'Restarting stops the Desktop app and its Host; running turns are interrupted.',
  zh: '重启会停止桌面端与 Host，正在进行的回合会被中断。',
}

/**
 * Output schemas stay as permissive as the tools shipped with the Harness:
 * one plain object per tool, no `oneOf`/`const`/`additionalProperties: false`.
 * A schema keyword the Host's validator rejects would fail the whole mount, and
 * this bundle must mount to keep the restart button alive.
 */
const FAIL_FIELDS = {
  code: { type: 'string', description: '稳定失败码：desktop-only / plan-busy / relaunch-unavailable / shell-alive / not-approved / nested-agent / continuation-without-self / invalid-argument / store-failed / internal' },
  message: { type: 'string', description: '给人看的失败说明。' },
}

const RESTART_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'true=计划已写入并安排了重启（或演练成功）。' },
    planId: { type: 'string', description: '本次重启计划 id。' },
    restarting: { type: 'boolean', description: 'true=即将停壳重启；dryRun 时为 false。' },
    restartInMs: { type: 'number', description: '距离停壳的毫秒数；dryRun 时为 0。' },
    willResume: {
      type: 'array',
      description: '重启后会被续作的会话：根会话直接续作，子智能体经其父会话冷启动续作。',
      items: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          kind: { type: 'string', description: 'root=根会话；subagent=子智能体。' },
        },
      },
    },
    tasks: {
      type: 'array',
      description: '已排队的重启后任务。',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          target: { type: 'string' },
          prompt: { type: 'string' },
        },
      },
    },
    note: { type: 'string', description: '下一步说明：本会话在恢复范围时包含「重启后本会话会自动续作」，不在范围时说明不会续作。' },
    ...FAIL_FIELDS,
  },
  required: ['ok'],
}

const STATUS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    active: { type: 'boolean', description: '当前是否有正在执行/等待执行的重启计划。' },
    plan: { type: 'string', description: '当前计划摘要；没有时为空串。' },
    last: { type: 'string', description: '最近一次完成的重启摘要；没有记录时为空串。' },
    unfinished: {
      type: 'array',
      description: '未完成或失败的条目（resume:<id>:<state> / task:<id>:<state>）。',
      items: { type: 'string' },
    },
    ...FAIL_FIELDS,
  },
  required: ['ok'],
}

const CANCEL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    cancelled: { type: 'boolean', description: 'true=计划已删除；false=没有可取消的计划。' },
    planId: { type: 'string', description: '被取消的计划 id；没有时为空串。' },
    ...FAIL_FIELDS,
  },
  required: ['ok'],
}

const RESUME_PARAMETER = {
  type: 'string',
  enum: ['interrupted', 'self', 'none'],
  description: '重启后恢复哪些会话。interrupted=重启瞬间正处在回合中的所有根会话**及其正在运行的子智能体**（默认）；'
    + 'self=只恢复本会话；none=不恢复。要指定具体会话请用 sessions。',
}

const SESSIONS_PARAMETER = {
  type: 'array',
  items: { type: 'string' },
  description: '显式恢复这些会话 id（给定时覆盖 resume；即使当时不在回合中也会续作）。',
}

const TASK_PARAMETER = {
  type: 'array',
  description: '重启完成后要执行的任务；每个任务在重启后的新会话（默认）或指定会话里发一条 prompt。',
  items: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '任务内容，自包含：重启后执行时看不到当前对话。' },
      title: { type: 'string', description: '新会话标题（可选）。' },
      newSession: { type: 'boolean', description: 'true=开新会话（默认）；false 时必须给 sessionId。' },
      sessionId: { type: 'string', description: 'newSession=false 时的目标会话。' },
      cwd: { type: 'string', description: '新会话的工作目录（默认与本会话一致）。' },
      agentPreset: { type: 'string', description: '新会话的预设（默认与本会话一致）。' },
      at: { type: 'string', description: '可选：不早于该 ISO 时间执行；未到时间的任务保持 pending。' },
    },
    required: ['prompt'],
  },
}

/** Language for one tool call: profile override, else the conversation language. */
function toolLanguage(config, exec) {
  if (config.continuationLanguage === 'zh' || config.continuationLanguage === 'en') return config.continuationLanguage
  return languageFromSession(exec?.agent?.session)
}

/** Standard failure value. */
function fail(code, language) {
  return { ok: false, code, message: errorText(code, language) }
}

/** Static contradiction between `continuation` and an explicit resume scope. */
function continuationRefusedEarly(mode, input, exec) {
  const hint = typeof input.continuation === 'string' ? input.continuation.trim() : ''
  if (hint === '') return false
  if (mode === 'none') return true
  if (!Array.isArray(mode)) return false
  const selfId = typeof exec?.agent?.session?.id === 'string' ? exec.agent.session.id : ''
  return selfId === '' || !mode.includes(selfId)
}

/**
 * Ask the Agent approval service whether this restart may proceed.
 *
 * `unavailable` (no answerer, for example a non-interactive profile) proceeds:
 * the bundle only has a restart path under the interactive Desktop shell. Only
 * an explicit rejection or cancellation refuses.
 */
export async function approvalOutcome(ctx, exec, config, language) {
  if (config.requireApproval !== true) return 'skipped'
  const approval = typeof ctx?.get === 'function' ? ctx.get('approval') : undefined
  if (approval === undefined || typeof approval.request !== 'function') return 'unavailable'
  if (exec?.agent === undefined) return 'unavailable'
  try {
    const outcome = await approval.request({
      agent: exec.agent,
      toolName: RESTART_TOOL,
      ...(typeof exec.callId === 'string' ? { callId: exec.callId } : {}),
      reason: APPROVAL_REASON[language === 'en' ? 'en' : 'zh'],
      displayReason: APPROVAL_DISPLAY,
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    })
    return typeof outcome === 'string' ? outcome : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** Last-restart line for the status tool. */
function lastRestartLine(last, language) {
  const finished = formatTime(last.finishedAt, language)
  if (language === 'en') {
    return `${last.planId} · finished ${finished} · ${last.resumed} session(s) resumed, ${last.tasks} task(s) started${last.ok ? '' : ' · some entries failed'}`
  }
  return `${last.planId} · 完成于 ${finished} · 恢复 ${last.resumed} 个会话、启动 ${last.tasks} 个任务${last.ok ? '' : ' · 有失败条目'}`
}

/**
 * Build the three tool definitions for one mounted plugin.
 * @param {object} input - `{ ctx, config, directory, log }`.
 * @returns {object[]} - tool definitions for `ctx.tools.register`.
 */
export function createTools({ ctx, config, directory, log = () => {} }) {
  const restartTool = {
    name: RESTART_TOOL,
    description: '重启桌面端（应用与 Host），并在重启完成后继续原来的工作。\n\n'
      + '调用前会弹出审批卡；确认后先把重启计划写入磁盘，再停壳并自动拉起应用。计划包含两部分：\n'
      + '1. 恢复：默认恢复「重启瞬间正处在回合中」的所有根会话**和它们的子智能体**（resume=interrupted；也可用 self / none，'
      + '或用 sessions 指定会话 id）。每个被恢复的会话在重启后会收到一条续作指令，'
      + '从日志里的最后一个检查点继续，不重做已完成的工作；子智能体由它的父会话冷启动续作，结论回传给父会话。'
      + 'continuation 只写进**本会话**那一条，其他被恢复的会话只收到标准续作指令；\n'
      + '2. 任务：在 tasks 里排队重启后要执行的工作（默认各开一个新会话）。\n\n'
      + '工具返回后约 1.5 秒应用才会重启，所以本次调用的结果会先写进会话日志。重启完成后本会话会自动续作'
      + '（resume 把本会话排除在外时除外），不要在同一个回合里重复调用本工具。计划、进度与回执可用 harness_restart_status 查看。\n'
      + '仅 Windows 桌面端、仅根会话可用；dryRun=true 只回报计划、不重启。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', description: '为什么要重启；会写进计划、续作指令和日志，便于事后复盘。' },
        resume: RESUME_PARAMETER,
        sessions: SESSIONS_PARAMETER,
        continuation: {
          type: 'string',
          description: '重启后**本会话**要做什么（可选）：只拼进调用方自己的续作指令，其他被恢复的会话看不到它。'
            + '给定时本会话必须在恢复范围里（resume 是 self / interrupted，或 sessions 包含本会话），'
            + '否则返回 continuation-without-self，不重启。',
        },
        tasks: TASK_PARAMETER,
        dryRun: { type: 'boolean', description: 'true=只写计划预览、不重启；默认 false。' },
      },
      required: [],
    },
    output: {
      schema: RESTART_OUTPUT_SCHEMA,
      render(_args, value) {
        if (value?.ok === false) return [{ type: 'text', text: `重启没有开始：${value.message}` }]
        const lines = [value.restarting ? '已安排重启（约 1.5 秒后停壳并拉起应用）' : '演练完成（未重启）']
        lines.push(value.willResume.length === 0
          ? '恢复：无'
          : `恢复：${value.willResume.map((entry) => (entry.kind === 'subagent' ? `${entry.sessionId}（子）` : entry.sessionId)).join('、')}`)
        if (value.tasks.length > 0) {
          lines.push(`任务：${value.tasks.map((task) => `${task.id}（${task.target === 'new' ? '新会话' : `会话 ${task.target}`}）`).join('、')}`)
        }
        lines.push(value.note)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 120_000,
    async execute(args, exec) {
      const input = args !== null && typeof args === 'object' ? args : {}
      const language = toolLanguage(config, exec)
      try {
        /* A subagent must not be able to stop the application under its parent. */
        const header = exec?.agent?.session?.header
        if (header !== null && typeof header === 'object' && typeof header.parentSession === 'string') {
          return fail('nested-agent', language)
        }
        /* Arguments are validated before the environment check, so a bad call
         * reads the same on every Host. */
        const mode = normalizeResumeMode(
          Array.isArray(input.sessions) && input.sessions.some((entry) => typeof entry === 'string' && entry.trim() !== '')
            ? input.sessions.filter((entry) => typeof entry === 'string' && entry.trim() !== '').map((entry) => entry.trim())
            : input.resume,
        )
        if (mode === null) return fail('invalid-argument', language)
        /* A contradiction the arguments already prove is refused before the
         * user is asked to approve a restart that would then be abandoned. */
        if (continuationRefusedEarly(mode, input, exec)) return fail('continuation-without-self', language)
        const tasks = normalizeTasks(input.tasks, config.maxTasks)
        if (!tasks.ok) return fail(tasks.code, language)
        if (!desktopHost()) return fail('desktop-only', language)
        if (input.dryRun !== true) {
          const approval = await approvalOutcome(ctx, exec, config, language)
          if (approval === 'rejected' || approval === 'cancelled') return fail('not-approved', language)
          /* No answerer means no consent was obtained; the button remains a way
           * for the user to restart deliberately. */
          if (approval === 'unavailable') return fail('approval-unavailable', language)
        }
        const session = exec?.agent?.session
        const requestedBy = {
          ...(typeof session?.id === 'string' ? { sessionId: session.id } : {}),
          ...(typeof session?.header?.cwd === 'string' ? { cwd: session.header.cwd } : {}),
          ...(typeof session?.header?.agentPreset === 'string' ? { agentPreset: session.header.agentPreset } : {}),
        }
        const outcome = await requestRestart(ctx, {
          config,
          directory,
          log,
          origin: 'tool',
          reason: input.reason,
          mode,
          continuation: input.continuation,
          tasks: tasks.tasks,
          requestedBy,
          language,
          dryRun: input.dryRun === true,
        })
        if (outcome.ok !== true) return fail(outcome.code, language)
        const plan = outcome.plan
        const dryRun = outcome.dryRun === true
        return {
          ok: true,
          planId: plan.planId,
          restarting: dryRun !== true,
          restartInMs: dryRun ? 0 : config.restartDelayMs,
          willResume: plan.resume.map((entry) => ({
            sessionId: entry.sessionId,
            kind: entry.kind === 'subagent' ? 'subagent' : 'root',
          })),
          tasks: plan.tasks.map((task) => ({
            id: task.id,
            target: task.target,
            prompt: task.prompt.length > 200 ? `${task.prompt.slice(0, 200)}…` : task.prompt,
          })),
          note: restartNote({
            restartInMs: config.restartDelayMs,
            resumeCount: plan.resume.length,
            subagentCount: plan.resume.filter((entry) => entry.kind === 'subagent').length,
            taskCount: plan.tasks.length,
            language,
            dryRun,
            /* Only a resumed Session is promised a continuation prompt. */
            selfResumed: typeof plan.requestedBy?.sessionId === 'string'
              && plan.requestedBy.sessionId !== ''
              && plan.resume.some((entry) => entry.sessionId === plan.requestedBy.sessionId),
          }),
        }
      } catch (error) {
        log(`tool ${RESTART_TOOL} threw: ${String(error?.message ?? error)}`)
        return fail('internal', language)
      }
    },
  }

  const statusTool = {
    name: 'harness_restart_status',
    description: '查看重启计划的状态：当前是否有计划在执行、最近一次重启的结果（恢复/任务/失败），'
      + '以及仍未完成的条目。用于回答「上次重启后恢复得怎么样」。',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: STATUS_OUTPUT_SCHEMA,
      render(_args, value) {
        if (value?.ok === false) return [{ type: 'text', text: `读取重启状态失败：${value.message}` }]
        const lines = [value.active ? '当前计划：进行中' : '当前计划：无']
        if (value.plan !== '') lines.push(value.plan)
        lines.push(value.last === '' ? '最近一次重启：无记录' : `最近一次重启：${value.last}`)
        if (value.unfinished.length > 0) lines.push(`未完成：${value.unfinished.join('、')}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 30_000,
    async execute(_args, exec) {
      const language = toolLanguage(config, exec)
      try {
        let plan = null
        try {
          plan = readPlan(directory)
        } catch {
          plan = null
        }
        const active = plan !== null && isActive(plan) && !isExpired(plan)
        let last = null
        try {
          last = recentPlanSummary(directory)
        } catch {
          last = null
        }
        const unfinished = []
        if (plan !== null) {
          for (const entry of Array.isArray(plan.resume) ? plan.resume : []) {
            if (entry.state !== 'delivered' && entry.state !== 'skipped') unfinished.push(`resume:${entry.sessionId}:${entry.state}`)
          }
          for (const task of Array.isArray(plan.tasks) ? plan.tasks : []) {
            if (task.state !== 'delivered' && task.state !== 'skipped') unfinished.push(`task:${task.id}:${task.state}`)
          }
        }
        return {
          ok: true,
          active,
          plan: summarizePlan(plan, language) ?? '',
          last: last === null ? '' : lastRestartLine(last, language),
          unfinished,
        }
      } catch (error) {
        log(`tool harness_restart_status threw: ${String(error?.message ?? error)}`)
        return fail('internal', language)
      }
    },
  }

  const cancelTool = {
    name: 'harness_restart_cancel',
    description: '取消一个还没真正开始的重启计划（计划已写入但重启尚未进入停壳阶段时）。'
      + '已经开始重启（正在重启/正在执行）的计划无法取消；返回 cancelled=false 说明原因。',
    parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
    output: {
      schema: CANCEL_OUTPUT_SCHEMA,
      render(_args, value) {
        if (value?.ok === false) return [{ type: 'text', text: `取消重启失败：${value.message}` }]
        return [{
          type: 'text',
          text: value.cancelled ? `已取消重启计划 ${value.planId}` : '没有可取消的计划（可能已经开始重启或已执行完）',
        }]
      },
    },
    timeoutMs: 30_000,
    async execute(_args, exec) {
      const language = toolLanguage(config, exec)
      /* The same root-only rule as the restart tool: a subagent must not tear
       * down its parent's in-flight restart plan. */
      const header = exec?.agent?.session?.header
      if (header !== null && typeof header === 'object' && typeof header.parentSession === 'string') {
        return fail('nested-agent', language)
      }
      try {
        let lock = null
        try {
          lock = acquireLock(directory, { pid: process.pid })
        } catch {
          lock = null
        }
        if (lock === null) {
          /* A restart request in flight holds the lock; its plan is already on
           * its way to the shell stop and must not be deleted underneath it. */
          let current = null
          try {
            current = readPlan(directory)
          } catch {
            current = null
          }
          return { ok: true, cancelled: false, planId: current === null ? '' : current.planId }
        }
        try {
          let plan = null
          try {
            plan = readPlan(directory)
          } catch {
            plan = null
          }
          if (plan === null || plan.state !== STATE.armed) {
            return { ok: true, cancelled: false, planId: plan === null ? '' : plan.planId }
          }
          clearPlan(directory)
          appendReceipt(directory, { type: 'plan-cancelled', planId: plan.planId })
          log(`plan ${plan.planId} cancelled by tool`)
          return { ok: true, cancelled: true, planId: plan.planId }
        } finally {
          lock.release()
        }
      } catch (error) {
        log(`tool harness_restart_cancel threw: ${String(error?.message ?? error)}`)
        return fail('internal', language)
      }
    },
  }

  return [restartTool, statusTool, cancelTool]
}
