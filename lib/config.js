/**
 * Configuration for the harness-restart bundle.
 *
 * Every value has a working default, so a profile may keep `config: {}`; the
 * plugin clamps anything a patch supplies instead of trusting it.
 *
 * @module dsh-harness-restart/lib/config
 */

/** Version both halves require before they act together. */
export const VERSION = '0.4.4'

/** Route path claimed by the Host half. */
export const ROUTE_PATH = '/dsh-harness-restart/restart'

/** Header only this page's own fetch sets; a cross-site form cannot send it. */
export const ACTION_HEADER = 'x-dsh-restart-action'

/** Exact header value accepted by the POST route. */
export const ACTION_VALUE = 'restart'

/** Header gating the language diagnostic; a page's own fetch can set it. */
export const PROBE_HEADER = 'x-dsh-restart-probe'

/** Exact header value accepted by the diagnostic PUT. */
export const PROBE_VALUE = '1'

/** Restart-policy defaults. */
export const DEFAULTS = Object.freeze({
  /** `interrupted` | `self` | `none` — the button path's resume policy. */
  resume: 'interrupted',
  /** Ask the Agent approval service before the tool restarts the app. */
  requireApproval: true,
  /** Upper bound on sessions continued after one restart. */
  maxResumeSessions: 8,
  /** Pause between two post-restart prompts, so a restart is not a token burst. */
  staggerMs: 800,
  /** Delay between the tool returning and the shell being stopped. */
  restartDelayMs: 1500,
  /** A plan older than this is never executed. */
  planTtlMinutes: 60,
  /** `auto` follows the conversation language; `zh` / `en` force one. */
  continuationLanguage: 'auto',
  /** Budget for flushing live sessions before the shell is stopped. */
  flushTimeoutMs: 3000,
  /** Wait before the boot restore runs, so the Host is serving. */
  bootDelayMs: 1500,
  /** Upper bound on restart-time tasks per plan. */
  maxTasks: 8,
  /** Override the plan store directory. */
  storeDir: null,
})

/**
 * Clamp one number into a range, falling back to the default.
 * @param {unknown} value - patch-supplied value.
 * @param {number} fallback - default.
 * @param {number} min - inclusive lower bound.
 * @param {number} max - inclusive upper bound.
 * @returns {number} - the accepted value.
 */
function numberInRange(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/**
 * Resolve the effective configuration.
 * @param {object|undefined} raw - the Loader's `config` object.
 * @returns {typeof DEFAULTS} - a complete, validated configuration.
 */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const resume = typeof config.resume === 'string' ? config.resume.trim().toLowerCase() : DEFAULTS.resume
  const language = typeof config.continuationLanguage === 'string'
    ? config.continuationLanguage.trim().toLowerCase()
    : DEFAULTS.continuationLanguage
  return {
    resume: resume === 'self' || resume === 'none' ? resume : DEFAULTS.resume,
    requireApproval: config.requireApproval !== false,
    maxResumeSessions: numberInRange(config.maxResumeSessions, DEFAULTS.maxResumeSessions, 1, 30),
    staggerMs: numberInRange(config.staggerMs, DEFAULTS.staggerMs, 0, 5000),
    restartDelayMs: numberInRange(config.restartDelayMs, DEFAULTS.restartDelayMs, 300, 10000),
    planTtlMinutes: numberInRange(config.planTtlMinutes, DEFAULTS.planTtlMinutes, 1, 1440),
    continuationLanguage: language === 'zh' || language === 'en' ? language : DEFAULTS.continuationLanguage,
    flushTimeoutMs: numberInRange(config.flushTimeoutMs, DEFAULTS.flushTimeoutMs, 500, 15000),
    bootDelayMs: numberInRange(config.bootDelayMs, DEFAULTS.bootDelayMs, 0, 15000),
    maxTasks: numberInRange(config.maxTasks, DEFAULTS.maxTasks, 1, 20),
    storeDir: typeof config.storeDir === 'string' && config.storeDir.trim() !== '' ? config.storeDir.trim() : null,
  }
}
