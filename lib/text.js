/**
 * Model-facing and page-facing text for the harness-restart bundle.
 *
 * The continuation prompt is the only place this plugin speaks into a Session,
 * so its wording is deliberate: it states what happened, forbids redoing
 * finished work, and forbids a restart loop. Language follows the conversation
 * unless the profile forces one.
 *
 * @module dsh-harness-restart/lib/text
 */
import { formatTime } from './plan.js'

/** Han characters used to recognize a Chinese conversation. */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u

/**
 * Pick the language of the text a plan will emit.
 * @param {string[]|string} samples - conversation samples.
 * @param {'zh'|'en'} [fallback] - language when no sample is usable.
 * @returns {'zh'|'en'} - detected language.
 */
export function detectLanguage(samples, fallback = 'zh') {
  const parts = Array.isArray(samples) ? samples : [samples]
  const text = parts.filter((part) => typeof part === 'string').join('\n').trim()
  if (text === '') return fallback
  if (CJK.test(text)) return 'zh'
  return /[a-z]/iu.test(text) ? 'en' : fallback
}

/**
 * Text of one message content array.
 * @param {object|undefined} message - a Session message.
 * @returns {string} - concatenated text blocks.
 */
export function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text'
      && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Language of the most recent user message in a live Session.
 *
 * Reading the tail of the in-memory log is cheap and gives the same answer a
 * human would: the continuation should speak the language this conversation
 * already uses.
 * @param {object|undefined} session - live Session.
 * @param {'zh'|'en'} [fallback] - language when the tail has no user text.
 * @returns {'zh'|'en'} - detected language.
 */
export function languageFromSession(session, fallback = 'zh') {
  try {
    const seq = Number(session?.seq ?? 0)
    if (!Number.isFinite(seq) || seq <= 0) return fallback
    const events = session.snapshotEvents(Math.max(0, seq - 80), seq)
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const text = messageText(event?.data?.message)
      if (text !== '') return detectLanguage([text], fallback)
    }
  } catch {
    /* a disposed or foreign Session must not break a restart request */
  }
  return fallback
}

/**
 * Resolve the language for one plan.
 * @param {{continuationLanguage:string}} config - effective configuration.
 * @param {string[]|string} samples - conversation samples.
 * @returns {'zh'|'en'} - configured language or the detected one.
 */
export function planLanguage(config, samples) {
  const configured = config?.continuationLanguage
  if (configured === 'zh' || configured === 'en') return configured
  return detectLanguage(samples, 'zh')
}

/** Short task description used inside the continuation prompt. */
function taskLine(task, index, language) {
  const prompt = typeof task?.prompt === 'string' ? task.prompt.replace(/\s+/gu, ' ').trim() : ''
  const clipped = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt
  const target = task?.target === 'session' ? (language === 'en' ? 'this session' : '指定会话') : (language === 'en' ? 'new session' : '新会话')
  return `${index + 1}. [${target}] ${clipped}`
}

/**
 * Build the prompt a resumed Session receives after the restart.
 * @param {object} input - `{ plan, entry, language }`.
 * @returns {string} - the continuation instruction.
 */
export function continuationText({ plan, entry, language = 'zh' }) {
  const zh = language !== 'en'
  const when = formatTime(Number.isFinite(plan?.createdAt) ? plan.createdAt : Date.now(), language)
  const reason = typeof plan?.reason === 'string' && plan.reason.trim() !== '' ? plan.reason.trim() : ''
  const hint = typeof entry?.continuationHint === 'string' ? entry.continuationHint.trim() : ''
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : []
  const lines = []

  if (zh) {
    lines.push(`[harness-restart] 宿主刚完成一次重启（${when}${reason === '' ? '' : `，原因：${reason}`}）。`)
    lines.push('本会话在重启时被中断，日志里的最后一步可能停在半途：未完成的工具调用已经被标记为中断，这不是真的报错。')
    lines.push('')
    lines.push('请按顺序继续：')
    lines.push('1. 先用一两句话说明重启前的进度和下一步要做什么（信息都在日志里，不需要我复述）。')
    lines.push('2. 从最后一个检查点继续；已完成的工作不要重做，没跑完的命令重新跑一次。')
    lines.push('3. 如果原任务其实已经完成，直接说明并等待我的下一条指令。')
    if (tasks.length > 0) {
      lines.push(`4. 本次重启另外排队了 ${tasks.length} 个重启后任务，它们会各自执行，不需要你代做：`)
      for (const [index, task] of tasks.entries()) lines.push(`   ${taskLine(task, index, language)}`)
    }
    if (hint !== '') {
      lines.push('')
      lines.push(`本次重启的额外提示：${hint}`)
    }
    lines.push('')
    lines.push('除非我明确要求，不要再次调用 harness_restart。')
    return lines.join('\n')
  }

  lines.push(`[harness-restart] The Host just restarted (${when}${reason === '' ? '' : `; reason: ${reason}`}).`)
  lines.push('This Session was interrupted by the restart. The last step in the log may stop mid-way: unfinished tool calls were marked interrupted, which is not a real failure.')
  lines.push('')
  lines.push('Continue in this order:')
  lines.push('1. State in one or two sentences what was in progress and what comes next (it is all in the log; do not ask me to repeat it).')
  lines.push('2. Continue from the last checkpoint. Do not redo finished work; rerun commands that never finished.')
  lines.push('3. If the original task is actually complete, say so and wait for my next instruction.')
  if (tasks.length > 0) {
    lines.push(`4. ${tasks.length} post-restart task(s) are queued separately; they run on their own and are not yours to do:`)
    for (const [index, task] of tasks.entries()) lines.push(`   ${taskLine(task, index, language)}`)
  }
  if (hint !== '') {
    lines.push('')
    lines.push(`Extra note for this restart: ${hint}`)
  }
  lines.push('')
  lines.push('Do not call harness_restart again unless I explicitly ask for it.')
  return lines.join('\n')
}

/**
 * One-line note returned by the restart tool.
 * @param {object} input - `{ restartInMs, resumeCount, taskCount, language, dryRun }`.
 * @returns {string} - note for the model.
 */
export function restartNote({ restartInMs = 0, resumeCount = 0, taskCount = 0, language = 'zh', dryRun = false }) {
  const zh = language !== 'en'
  if (dryRun) {
    return zh
      ? `演练完成：没有重启。按计划会恢复 ${resumeCount} 个会话、启动 ${taskCount} 个任务。`
      : `Dry run: nothing restarted. The plan would resume ${resumeCount} session(s) and start ${taskCount} task(s).`
  }
  const seconds = Math.max(1, Math.round(restartInMs / 1000))
  return zh
    ? `约 ${seconds} 秒后重启；重启完成后本会话会自动收到一条续作指令（恢复 ${resumeCount} 个会话，启动 ${taskCount} 个任务），不需要再次调用本工具。`
    : `Restarting in about ${seconds}s. After the restart this Session receives a continuation instruction automatically (${resumeCount} session(s) resumed, ${taskCount} task(s) started); do not call this tool again.`
}

/** Human text for every stable failure code. */
export const ERROR_TEXT = Object.freeze({
  'desktop-only': {
    zh: '只有 Windows 桌面端支持自动重启：Host 由 Electron 壳托管时才能停壳并拉起应用。',
    en: 'Automatic restart is available only in the Windows Desktop app: the Host must be supervised by the Electron shell.',
  },
  'plan-busy': {
    zh: '已经有一次重启正在执行，等它完成再试。',
    en: 'A restart is already in flight; wait for it to finish.',
  },
  'relaunch-unavailable': {
    zh: '重启助手没能就绪，应用没有被重启（什么都没动）。',
    en: 'The relaunch assistant did not become ready, so nothing was restarted.',
  },
  'shell-alive': {
    zh: '停止桌面壳没有生效，重启已中止（应用仍在运行）。',
    en: 'Stopping the shell did not take effect; the restart was aborted and the app kept running.',
  },
  'not-approved': {
    zh: '用户拒绝或取消了这次重启。',
    en: 'The user rejected or cancelled this restart.',
  },
  'approval-unavailable': {
    zh: '当前没有可用的审批应答者，重启没有开始。请让用户在标题栏点击「重启」，或在配置里设 requireApproval: false。',
    en: 'No approval answerer is available, so the restart did not start. Ask the user to use the Restart control, or set requireApproval: false.',
  },
  'store-failed': {
    zh: '重启计划写入磁盘失败，重启已中止。',
    en: 'The restart plan could not be written to disk, so the restart was aborted.',
  },
  'invalid-argument': {
    zh: '参数不合法，重启没有开始。',
    en: 'Invalid argument; the restart did not start.',
  },
  cancelled: {
    zh: '重启计划已取消。',
    en: 'The restart plan was cancelled.',
  },
  internal: {
    zh: '重启工具内部出错，重启没有开始。',
    en: 'The restart tool failed internally; nothing was restarted.',
  },
  'nested-agent': {
    zh: '只有根会话可以发起重启；子智能体请先把需求交给父会话。',
    en: 'Only a root Session may request a restart; a subagent has to ask its parent instead.',
  },
})

/**
 * Localized text for a failure code.
 * @param {string} code - stable failure code.
 * @param {'zh'|'en'} [language] - target language.
 * @returns {string} - human sentence.
 */
export function errorText(code, language = 'zh') {
  const entry = ERROR_TEXT[code]
  if (entry === undefined) return language === 'en' ? `Restart failed (${code}).` : `重启失败（${code}）。`
  return language === 'en' ? entry.en : entry.zh
}
