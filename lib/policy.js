/**
 * Which Sessions a restart continues.
 *
 * The decision is split in two so it can be tested without a Harness: a
 * snapshot of the live root Sessions (in-memory, cheap) and a pure selection
 * over that snapshot.
 *
 * @module dsh-harness-restart/lib/policy
 */

/** Resume policies a request may name. */
export const RESUME_MODES = Object.freeze(['interrupted', 'self', 'none'])

/**
 * Normalize the `resume` argument.
 * @param {unknown} value - `interrupted` | `self` | `none` | string[] | undefined.
 * @returns {'interrupted'|'self'|'none'|string[]|null} - null means invalid.
 */
export function normalizeResumeMode(value) {
  if (value === undefined || value === null || value === '') return 'interrupted'
  if (typeof value === 'string') {
    const mode = value.trim().toLowerCase()
    return RESUME_MODES.includes(mode) ? mode : null
  }
  if (Array.isArray(value)) {
    const ids = value
      .filter((entry) => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim())
    const unique = Array.from(new Set(ids))
    return unique.length === 0 ? 'none' : unique
  }
  return null
}

/**
 * Select the Sessions to continue after the restart.
 * @param {object} input - `{ candidates, mode, selfSessionId, cap }`.
 * @returns {object[]} - entries in delivery order.
 */
export function selectResumeEntries({ candidates, mode, selfSessionId, cap = 8 }) {
  const list = Array.isArray(candidates) ? candidates.filter((entry) => typeof entry?.sessionId === 'string') : []
  const limit = Number.isInteger(cap) && cap >= 0 ? cap : 8
  if (mode === 'none' || limit === 0) return []
  let chosen
  if (mode === 'self') {
    chosen = typeof selfSessionId === 'string' ? list.filter((entry) => entry.sessionId === selfSessionId) : []
  } else if (Array.isArray(mode)) {
    /* An explicitly named Session is continued even when it is not mid-turn:
     * the caller asked for that Session, not for its current activity. */
    chosen = mode.map((sessionId) => {
      const known = list.find((entry) => entry.sessionId === sessionId)
      return known ?? { sessionId }
    })
  } else {
    chosen = [...list].sort((left, right) => {
      const leftSelf = left.sessionId === selfSessionId ? 1 : 0
      const rightSelf = right.sessionId === selfSessionId ? 1 : 0
      if (leftSelf !== rightSelf) return rightSelf - leftSelf
      return (right.lastEventTime ?? 0) - (left.lastEventTime ?? 0)
    })
  }
  const seen = new Set()
  const unique = []
  for (const entry of chosen) {
    if (seen.has(entry.sessionId)) continue
    seen.add(entry.sessionId)
    unique.push(entry)
  }
  return unique.slice(0, limit)
}

/** The last few events of a live Session, or an empty array. */
function tailEvents(session, count) {
  try {
    const seq = Number(session?.seq ?? 0)
    if (!Number.isFinite(seq) || seq <= 0) return []
    return session.snapshotEvents(Math.max(0, seq - count), seq)
  } catch {
    return []
  }
}

/**
 * Resolve the turn-boundary reader for this Host.
 *
 * `agents.turnBoundaryOf` is the convenience API of newer Hosts; older ones
 * only install the `turnBoundary` Session projection, which the loop itself
 * reads. Returning `undefined` means neither exists, and the caller falls back
 * to the Agent's own run status.
 */
function turnBoundaryReader(ctx, agents) {
  if (typeof agents?.turnBoundaryOf === 'function') {
    return (session) => agents.turnBoundaryOf(session)
  }
  const projections = typeof ctx?.get === 'function' ? ctx.get('sessionProjections') : undefined
  if (projections !== undefined && typeof projections.stateOf === 'function') {
    return (session) => projections.stateOf(session, 'turnBoundary')
  }
  return undefined
}

/**
 * Snapshot the live root Sessions that are in a turn right now.
 *
 * A Session that finished its turn — or was deliberately stopped, which closes
 * the turn — is not selected. Subagent children are excluded: `roots()` returns
 * roots only. When the Host exposes no turn-boundary API at all, a running
 * Agent is treated as inside a turn so the feature degrades instead of
 * silently selecting nothing.
 * @param {object} ctx - Host context.
 * @param {{log?: Function}} [options] - optional logger for the degraded path.
 * @returns {object[]} - candidate entries.
 */
export function collectCandidates(ctx, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const agents = typeof ctx?.get === 'function' ? ctx.get('agents') : undefined
  if (agents === undefined || typeof agents.roots !== 'function') return []
  const reader = turnBoundaryReader(ctx, agents)
  if (reader === undefined) {
    log('restart: no turn-boundary API available; falling back to Agent.status for resume selection')
  }
  let roots
  try {
    roots = agents.roots()
  } catch {
    return []
  }
  const candidates = []
  for (const agent of Array.isArray(roots) ? roots : []) {
    try {
      const session = agent?.session
      if (session === undefined) continue
      let open = false
      let openTurnStartSeq
      let lastTurn
      if (reader === undefined) {
        open = agent.status === 'running'
      } else {
        const boundary = reader(session)
        /* The projection is absent until the Session records its first turn. */
        if (boundary === undefined || boundary === null) continue
        open = boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined
        openTurnStartSeq = boundary.openTurnStartSeq
        lastTurn = boundary.lastTurn
      }
      if (!open) continue
      const header = session.header !== null && typeof session.header === 'object' ? session.header : {}
      const tail = tailEvents(session, 40)
      const lastEvent = tail.length > 0 ? tail[tail.length - 1] : undefined
      candidates.push({
        sessionId: String(agent.id),
        ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
        ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
        ...(Number.isFinite(openTurnStartSeq) && openTurnStartSeq > 0 ? { openTurnStartSeq } : {}),
        ...(Number.isFinite(lastTurn) ? { lastTurn } : {}),
        lastEventTime: Number.isFinite(lastEvent?.time) ? lastEvent.time : Date.now(),
      })
    } catch {
      /* one broken Session must not discard the snapshot */
    }
  }
  return candidates
}
