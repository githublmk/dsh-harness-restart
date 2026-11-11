/**
 * Which Sessions a restart continues, and whose instruction they carry.
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
 *
 * Delivery order matters twice: the calling Session comes first so its own
 * instruction is never crowded out by the cap, and every root comes before the
 * subagents below it — a subagent can only be continued from its live parent,
 * so the parents must be revived first.
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
    const rank = (entry) => (entry.sessionId === selfSessionId ? 0 : (entry.kind === 'subagent' ? 2 : 1))
    const depth = (entry) => (Number.isFinite(entry.delegationDepth) ? entry.delegationDepth : 0)
    chosen = [...list].sort((left, right) => {
      const byRank = rank(left) - rank(right)
      if (byRank !== 0) return byRank
      /* Shallow children first: a grandchild is continued from its own parent. */
      if (rank(left) === 2) {
        const byDepth = depth(left) - depth(right)
        if (byDepth !== 0) return byDepth
      }
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

/**
 * Place the requesting Session's own post-restart instruction on its entry.
 *
 * `continuation` is written by the Session that calls the restart tool, about
 * what that Session does next. It belongs to that one entry: copied onto every
 * resumed Session it would read as this Session's work handed to unrelated
 * conversations. Other resumed Sessions keep the standard instruction.
 *
 * The instruction is only meaningful when its owner is actually resumed, so a
 * hint with no entry to land on is reported instead of dropped: the caller is
 * still running and can correct the request, whereas an after-restart note
 * would never be read by a Session that did not come back.
 * @param {object[]} entries - selected resume entries, mutated in place.
 * @param {{continuation?: unknown, selfSessionId?: unknown}} input - the hint and its owner.
 * @returns {boolean} - false only when a hint was supplied and no entry belongs to it.
 */
export function attachContinuationHint(entries, input = {}) {
  const hint = typeof input.continuation === 'string' ? input.continuation.trim() : ''
  if (hint === '') return true
  const selfSessionId = typeof input.selfSessionId === 'string' ? input.selfSessionId : ''
  if (selfSessionId === '') return false
  const own = (Array.isArray(entries) ? entries : []).find((entry) => entry?.sessionId === selfSessionId)
  if (own === undefined) return false
  own.continuationHint = hint
  return true
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
 * Snapshot the live Sessions that are in a turn right now: roots and the
 * subagents running under them.
 *
 * A Session that finished its turn — or was deliberately stopped, which closes
 * the turn — is not selected. Subagents are included because a restart
 * interrupts their work too: each child is recorded with the direct parent that
 * has to be live again before it can be continued. A child whose durable
 * lineage names no parent cannot be routed and is left out with a log line.
 * When the Host exposes no turn-boundary API at all, a running Agent is treated
 * as inside a turn so the feature degrades instead of silently selecting
 * nothing.
 * @param {object} ctx - Host context.
 * @param {{log?: Function}} [options] - optional logger for the degraded paths.
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
  const rootsList = Array.isArray(roots) ? roots : []
  const rootIds = new Set()
  for (const agent of rootsList) {
    if (typeof agent?.id === 'string') rootIds.add(agent.id)
  }
  /* `list()` adds the running children; a Host that predates it still resumes
   * its roots, so the feature degrades rather than failing. */
  let live = rootsList
  if (typeof agents.list === 'function') {
    try {
      const all = agents.list()
      if (Array.isArray(all)) live = all
    } catch {
      live = rootsList
    }
  }
  const candidates = []
  for (const agent of live) {
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
      const kind = rootIds.has(agent.id) ? 'root' : 'subagent'
      const parentSession = typeof header.parentSession === 'string' && header.parentSession !== ''
        ? header.parentSession
        : undefined
      if (kind === 'subagent' && parentSession === undefined) {
        log(`restart: subagent ${String(agent.id)} has no durable parent; it cannot be continued and is left out`)
        continue
      }
      const tail = tailEvents(session, 40)
      const lastEvent = tail.length > 0 ? tail[tail.length - 1] : undefined
      candidates.push({
        sessionId: String(agent.id),
        kind,
        ...(parentSession === undefined ? {} : { parentSession }),
        ...(Number.isFinite(header.delegationDepth) ? { delegationDepth: header.delegationDepth } : {}),
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
