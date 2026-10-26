/**
 * MetaTask tools for DSH — bridging the OAC CLI metatask surface to agent
 * tools. Read face: `metatask_list`, `metatask_get`, `metatask_replay`
 * (`metabot metatask list | get --root | replay --root`), the agent-tool
 * counterpart of the panel host routes (metatask-routes.ts — argv spelling
 * is identical). Participation-write face: `metatask_claim`,
 * `metatask_release`, `metatask_submit`, `metatask_verify` (`metabot
 * metatask claim | release | submit | verify`). OAC port of the IDBots
 * metatask faces: the CLI owns flag and `--request-file` parsing, and the
 * daemon-side writer owns every protocol gate (canon hashes, same-side
 * roster, replay guard, H_ACT3). Every call requires the OAC daemon
 * running; every write acts as the session's OAC bot (the slug is resolved
 * locally and passed as `--from` — no slug means no actor, and the tool
 * refuses before any round trip). This file renders compact views,
 * validates cheaply, builds argv/payload, and surfaces refusals verbatim;
 * it never re-implements protocol logic. Publisher verbs land in a later
 * round.
 */
import { runMetabotWithPayloadFile, type RunFn } from './cli-payload.js'
import type { MetabotCommandResult } from './cli-bridge.js'
import { shortMetaId, shortPin } from './metatask-logic.js'
import { oacSlugOf } from './browser-tools.js'
import type { HostAgentLike, HostContext, HostToolDefinition, HostToolExec } from './context-types.js'

/** Mirrors metatask-routes.ts (the panel bridge) — keep the values in sync. */
const READ_TIMEOUT_MS = 60_000
const REFRESH_TIMEOUT_MS = 180_000

/** Node rows rendered with full columns before the table goes slim (in-band). */
const NODE_TABLE_MAX = 40

/**
 * Writes are sized for multi-pin flows: a publish-class verb spends up to 4
 * pins (roster → tree → spec → task); 180s was sized for one refresh sweep.
 */
const METATASK_WRITE_TIMEOUT_MS = 300_000

const DAEMON_HINT = 'The metatask tools need the OAC daemon running — start it and retry.'

const NO_ACTOR_MESSAGE =
  'no OAC bot profile is bound to this session — metatask write verbs act as a specific MetaBot. '
  + 'Run the session under an OAC agent preset (its bot slug is passed as --from) or configure one first.'

function payloadObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function numberOf(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Tool error convention (metaweb-tools.ts): a readable STRING the model can act on. */
function toolError(tool: string, message: string): string {
  return `${tool} failed: ${message}`
}

/** CLI command failure: `metatask_<verb> failed: [<code>] <message>`, code optional. */
function commandFailure(tool: string, result: MetabotCommandResult): string {
  const code = result.code ? `[${result.code}] ` : ''
  return withDaemonHint(`${tool} failed: ${code}${result.message ?? result.state}`)
}

/** Thrown CLI-bridge errors (timeout, spawn failure) keep the same string shape. */
function thrownFailure(tool: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return withDaemonHint(toolError(tool, message))
}

/** Connectivity-shaped failures get the "start the daemon" hint. */
function withDaemonHint(text: string): string {
  return looksLikeDaemonIssue(text) ? `${text}\n(${DAEMON_HINT})` : text
}

function looksLikeDaemonIssue(message: string): boolean {
  return /daemon|econnrefused|connect|fetch failed|network|timed? ?out/i.test(message)
}

/** Display name through the payload identities map; falls back to the raw metaId. */
function displayName(identities: unknown, metaId: string): string {
  const row = payloadObject(payloadObject(identities)[metaId])
  return textOf(row.name) || metaId
}

// ── compact renderers (identity maps are consumed, never echoed) ─────────────

function renderBoard(data: unknown): string {
  const board = payloadObject(data)
  const tasks = Array.isArray(board.tasks) ? board.tasks : []
  const lines: string[] = [`# MetaTask board — ${tasks.length} task(s)`]
  for (const raw of tasks) {
    const task = payloadObject(raw)
    const rootPinId = textOf(task.rootPinId)
    const progress = payloadObject(task.progress)
    const myStats = task.myStats === null || task.myStats === undefined ? null : payloadObject(task.myStats)
    const roles = Array.isArray(task.myRoles) ? task.myRoles.filter((role) => typeof role === 'string') : []
    lines.push(`- ${textOf(task.title) || '(untitled)'} (pin://${rootPinId})`)
    const facts = [
      textOf(task.mode) || 'tree',
      `author ${displayName(board.identities, textOf(task.publisher))}`,
      `progress ${numberOf(progress.verified)}/${numberOf(progress.total)} done`,
      `${numberOf(task.participantCount)} participant(s)`,
    ]
    if (task.settlementFinalized === true) facts.push('settlement finalized')
    lines.push(`  ${facts.join(' · ')}`)
    const mine: string[] = []
    if (roles.length) mine.push(`my roles: ${roles.join(', ')}`)
    if (myStats) {
      mine.push(
        `my stats: claimed ${numberOf(myStats.claimed)}, submitted ${numberOf(myStats.submitted)}, `
        + `review votes ${numberOf(myStats.reviewVotes)}, share ${numberOf(myStats.shareBP)} bp `
        + `(est. ${numberOf(myStats.estShareBP)} bp)`,
      )
    }
    if (mine.length) lines.push(`  ${mine.join(' · ')}`)
  }
  if (!tasks.length) {
    lines.push('(no tasks in the local projection yet — pass refresh=true to sweep the chain first)')
  }
  const refresh = payloadObject(board.refresh)
  const boundaryBlock = numberOf(refresh.boundaryBlock, -1)
  if (boundaryBlock >= 0) {
    lines.push(
      `Board boundary block: ${boundaryBlock} — on-chain indexing lags; the boundary block is the truth anchor, never assume real-time.`,
    )
  }
  return lines.join('\n')
}

function renderTask(data: unknown): string {
  const task = payloadObject(data)
  const nodeStates = payloadObject(task.nodeStates)
  const entries = Object.values(nodeStates).map((node) => payloadObject(node))
  const identities = task.identities
  const lines: string[] = [
    `# ${textOf(task.title) || '(untitled)'} (pin://${textOf(task.rootPinId)})`,
    `author: ${displayName(identities, textOf(task.publisher))}`,
  ]
  const policy = payloadObject(task.policy)
  const policyFacts = [
    `mode ${textOf(policy.mode) || 'tree'}`,
    `quorum ${numberOf(policy.verifyQuorum)}`,
    `split ${numberOf(policy.submitterShareBP)}/10000 to contributors`,
  ]
  const progress = payloadObject(task.progress)
  const progressFacts = [
    `progress ${numberOf(progress.verified)}/${numberOf(progress.total)} done`,
    `claimed ${numberOf(progress.claimed)}`,
    `disputed ${numberOf(progress.disputed)}`,
  ]
  if (task.taskComplete === true) progressFacts.push('task complete')
  lines.push(`${policyFacts.join(' · ')}`)
  lines.push(`${progressFacts.join(' · ')}`)

  const openNodes = Array.isArray(task.openNodes) ? task.openNodes.map((node) => payloadObject(node)) : []
  if (openNodes.length) {
    const ids = openNodes.map((node) => `${textOf(node.id)}(${textOf(node.status)})`).join(', ')
    lines.push(`openNodes (every node still short of done — idle and in-flight): ${ids}`)
  }

  lines.push(`nodes (${entries.length}):`)
  const slim = entries.length > NODE_TABLE_MAX
  entries.forEach((node, index) => {
    const status = textOf(node.status) || '?'
    const disputed = node.disputed === true ? ' disputed' : ''
    if (index >= NODE_TABLE_MAX) {
      lines.push(`  - ${textOf(node.id)} [${status}${disputed}] (slim row)`)
      return
    }
    const holder = payloadObject(node.holder)
    const holderName = holder.claimant ? shortMetaId(textOf(holder.claimant)) : '-'
    const submission = payloadObject(node.submission)
    const lead = textOf(submission.pinId) ? ` lead ${shortPin(textOf(submission.pinId))}` : ''
    lines.push(
      `  - ${textOf(node.id)} [${status}${disputed}] w=${node.weight ?? '-'} holder=${holderName} `
      + `votes=${numberOf(node.passVotes)}✓/${numberOf(node.failVotes)}✗${lead}`,
    )
  })
  if (slim) {
    lines.push(`  (${entries.length - NODE_TABLE_MAX} node(s) beyond the first ${NODE_TABLE_MAX} shown slim — large task; metatask_replay gives the full state machine view)`)
  }

  const participants = Array.isArray(task.participants) ? task.participants : []
  if (participants.length) {
    const names = participants
      .slice(0, 8)
      .map((row) => displayName(identities, textOf(payloadObject(row).metaId)))
      .join(', ')
    lines.push(`participants (${participants.length}): ${names}${participants.length > 8 ? ' …' : ''}`)
  }

  const settlement = payloadObject(task.settlement)
  if (task.settlement !== null && task.settlement !== undefined && Object.keys(settlement).length) {
    const shares = Array.isArray(settlement.shares)
      ? settlement.shares.map((row) => {
          const share = payloadObject(row)
          return `${displayName(identities, textOf(share.metaId))} ${numberOf(share.shareBP)} bp`
        }).join(', ')
      : ''
    lines.push(`settlement (finalized) at boundary ${numberOf(settlement.boundaryBlock)}: ${shares || '(no shares)'}`)
  } else {
    const estimation = payloadObject(task.estimation)
    if (task.estimation !== null && task.estimation !== undefined && Object.keys(estimation).length) {
      const shares = Array.isArray(estimation.shares)
        ? estimation.shares.map((row) => {
            const share = payloadObject(row)
            return `${displayName(identities, textOf(share.metaId))} ${numberOf(share.shareBP)} bp`
          }).join(', ')
        : ''
      lines.push(`estimation (if it settled now, ${textOf(estimation.basis) || 'weighted'} basis): ${shares || '(no shares)'}`)
    }
  }

  const freshness = payloadObject(task.freshness)
  const fresh: string[] = []
  if (numberOf(freshness.boundaryBlock, -1) >= 0) fresh.push(`boundary block ${numberOf(freshness.boundaryBlock)}`)
  if (numberOf(freshness.eventCount, -1) >= 0) fresh.push(`${numberOf(freshness.eventCount)} events`)
  if (fresh.length) lines.push(`freshness: ${fresh.join(', ')}`)
  if (Array.isArray(task.ignoredEvents) && task.ignoredEvents.length) {
    lines.push(`ignored events: ${task.ignoredEvents.length} (metatask_replay lists each reason)`)
  }
  return lines.join('\n')
}

function renderReplay(data: unknown): string {
  return `MetaTask replay (pure derivation over the cached chain events):\n${JSON.stringify(data, null, 2)}`
}

// ── shared helpers ───────────────────────────────────────────────────────────

/**
 * Resolve the session's acting OAC bot slug (live session agent first, then
 * the composed preset). The write verbs pass it as `--from`; when no slug
 * resolves there is no actor and the tool refuses locally instead of doing a
 * daemon `actor_required` round trip. The read tools never need an actor.
 */
export function metataskActorSlug(host: HostContext, hostAgent: HostAgentLike, exec: HostToolExec): string {
  const agent = exec.agent ?? hostAgent
  const live = oacSlugOf(host, agent)
  if (live) return live
  const preset = host.agentPresets?.composedPreset?.(agent.ctx)
  return typeof preset === 'string' ? preset.replace(/^oac-/, '') : ''
}

/** Write success: the daemon writer's `data` object echoed as JSON. */
function renderWriteData(data: unknown): string {
  return typeof data === 'string' ? data : JSON.stringify(data, null, 2)
}

// ── builder + bind ───────────────────────────────────────────────────────────

export function buildMetataskTools(input: {
  host: HostContext
  hostAgent: HostAgentLike
  run?: RunFn
}): HostToolDefinition[] {
  const { host, hostAgent } = input
  const run = input.run ?? (async (args, options) => {
    const { runMetabot } = await import('./cli-bridge.js')
    return runMetabot(args, options)
  })

  const render = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
  ]

  const list: HostToolDefinition = {
    name: 'metatask_list',
    description:
      'List on-chain MetaTasks from the local chain-sourced projection: root pinId, title, root author, '
      + 'progress (done/total), participant count, my roles (root author / participant), my stats (activity '
      + 'counts plus settled and estimated share in basis points), and the board boundary block. '
      + 'Pass refresh=true to force a chain sweep first (slower; the default reads the cache). '
      + 'On-chain indexing lags — the boundary block is the truth anchor, never assume real-time. '
      + 'Requires the OAC daemon running.',
    parameters: {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'true to force a background chain sweep before reading (refresh is a parameter here, not a separate tool).',
        },
      },
    },
    output: { schema: { type: 'string' }, render },
    timeoutMs: REFRESH_TIMEOUT_MS,
    execute: async (args: Record<string, unknown>) => {
      const refresh = args.refresh === true
      try {
        const result = await run(
          ['metatask', 'list', ...(refresh ? ['--refresh'] : [])],
          { timeoutMs: refresh ? REFRESH_TIMEOUT_MS : READ_TIMEOUT_MS },
        )
        if (!result.ok) return commandFailure('metatask_list', result)
        return renderBoard(result.data)
      } catch (error) {
        return thrownFailure('metatask_list', error)
      }
    },
  }

  const get: HostToolDefinition = {
    name: 'metatask_get',
    description:
      'Get one MetaTask in full from the local projection: policy (TTL/quorum/window/split), every node with '
      + 'status, holder, weight and vote counts, the participant roster, and the settlement manifest when '
      + 'finalized. While the task is unfinished it also reports estimation — the if-it-settled-now share split '
      + 'in whole-task basis points (null once a manifest exists). openNodes lists every node still short of '
      + 'done (both idle ones and in-flight ones — broader than only the idle). Read-only board context. '
      + 'Requires the OAC daemon running.',
    parameters: {
      type: 'object',
      properties: {
        rootPinId: { type: 'string', description: 'Task root pinId (64 lowercase hex + i0, 66 chars).' },
        refresh: {
          type: 'boolean',
          description: 'true to force a background chain sweep of this task before reading.',
        },
      },
      required: ['rootPinId'],
    },
    output: { schema: { type: 'string' }, render },
    timeoutMs: REFRESH_TIMEOUT_MS,
    execute: async (args: Record<string, unknown>) => {
      const rootPinId = textOf(args.rootPinId)
      if (!rootPinId) return toolError('metatask_get', 'rootPinId is required.')
      const refresh = args.refresh === true
      try {
        const result = await run(
          ['metatask', 'get', '--root', rootPinId, ...(refresh ? ['--refresh'] : [])],
          { timeoutMs: refresh ? REFRESH_TIMEOUT_MS : READ_TIMEOUT_MS },
        )
        if (!result.ok) return commandFailure('metatask_get', result)
        return renderTask(result.data)
      } catch (error) {
        return thrownFailure('metatask_get', error)
      }
    },
  }

  const replay: HostToolDefinition = {
    name: 'metatask_replay',
    description:
      'Re-run the local MetaTask replay engine over the cached chain events for one task root and return the '
      + 'derived state table plus the settlement manifest (when finalizable): pure derivation, chain facts in, '
      + 'projection out. Use it to double-check a state before acting, or to compute the would-be settlement '
      + 'split. Read-only. Requires the OAC daemon running.',
    parameters: {
      type: 'object',
      properties: {
        rootPinId: { type: 'string', description: 'Task root pinId (64 lowercase hex + i0, 66 chars).' },
      },
      required: ['rootPinId'],
    },
    output: { schema: { type: 'string' }, render },
    timeoutMs: READ_TIMEOUT_MS,
    execute: async (args: Record<string, unknown>) => {
      const rootPinId = textOf(args.rootPinId)
      if (!rootPinId) return toolError('metatask_replay', 'rootPinId is required.')
      try {
        const result = await run(['metatask', 'replay', '--root', rootPinId], { timeoutMs: READ_TIMEOUT_MS })
        if (!result.ok) return commandFailure('metatask_replay', result)
        return renderReplay(result.data)
      } catch (error) {
        return thrownFailure('metatask_replay', error)
      }
    },
  }

  const claim: HostToolDefinition = {
    name: 'metatask_claim',
    description:
      'Claim an OPEN node of an on-chain MetaTask as the session acting OAC MetaBot (the bot slug is resolved '
      + 'from the session and passed as --from). The replay guard runs first and refuses without spending when '
      + 'the node is not open — the refusal `claim-rejected:<node>:<state>` is surfaced verbatim. The task root '
      + 'author (publisher) is refused its own task nodes (no self-claim). Before claiming, read the task with '
      + 'metatask_get and mean to do the node work: an effective claim starts a TTL clock and freezes the node '
      + 'against publisher amends. COMPETITIVE MODE: a claim is an intent signal only — no lock is taken and '
      + 'metatask_submit does not need the claimPinId (the result carries intentOnly: true). '
      + 'Requires the OAC daemon running.',
    parameters: {
      type: 'object',
      properties: {
        rootPinId: { type: 'string', description: 'Task root pinId (64 lowercase hex + i0, 66 chars).' },
        node: { type: 'string', description: 'Node id from the task tree (metatask_get).' },
      },
      required: ['rootPinId', 'node'],
    },
    output: { schema: { type: 'string' }, render },
    timeoutMs: METATASK_WRITE_TIMEOUT_MS,
    execute: async (args: Record<string, unknown>, exec: HostToolExec) => {
      const rootPinId = textOf(args.rootPinId)
      if (!rootPinId) return toolError('metatask_claim', 'rootPinId is required.')
      const node = textOf(args.node)
      if (!node) return toolError('metatask_claim', 'node is required.')
      const slug = metataskActorSlug(host, hostAgent, exec)
      if (!slug) return toolError('metatask_claim', NO_ACTOR_MESSAGE)
      try {
        const result = await run(
          ['metatask', 'claim', '--root', rootPinId, '--node', node, '--from', slug],
          { timeoutMs: METATASK_WRITE_TIMEOUT_MS },
        )
        if (!result.ok) return commandFailure('metatask_claim', result)
        return renderWriteData(result.data)
      } catch (error) {
        return thrownFailure('metatask_claim', error)
      }
    },
  }

  const release: HostToolDefinition = {
    name: 'metatask_release',
    description:
      'Voluntarily release your effective claim on a node (you cannot finish the work; the node reopens for '
      + 'others). The claim pin and node must match the current holder and the claim must be yours — both '
      + 'mismatches are refused writer-side and surfaced verbatim. Correcting an already-submitted work uses '
      + 'metatask_submit with supersedePinId instead of release-and-reclaim. COMPETITIVE MODE: there are no '
      + 'claim locks — release is a no-op and the writer refuses it rather than spending a pin; that refusal '
      + 'also surfaces verbatim. Requires the OAC daemon running.',
    parameters: {
      type: 'object',
      properties: {
        rootPinId: { type: 'string', description: 'Task root pinId (64 lowercase hex + i0, 66 chars).' },
        node: { type: 'string', description: 'Node id whose claim is being released.' },
        claimPinId: { type: 'string', description: 'The claim pin returned by metatask_claim (must be the current effective holder and yours).' },
      },
      required: ['rootPinId', 'node', 'claimPinId'],
    },
    output: { schema: { type: 'string' }, render },
    timeoutMs: METATASK_WRITE_TIMEOUT_MS,
    execute: async (args: Record<string, unknown>, exec: HostToolExec) => {
      const rootPinId = textOf(args.rootPinId)
      if (!rootPinId) return toolError('metatask_release', 'rootPinId is required.')
      const node = textOf(args.node)
      if (!node) return toolError('metatask_release', 'node is required.')
      const claimPinId = textOf(args.claimPinId)
      if (!claimPinId) return toolError('metatask_release', 'claimPinId is required.')
      const slug = metataskActorSlug(host, hostAgent, exec)
      if (!slug) return toolError('metatask_release', NO_ACTOR_MESSAGE)
      try {
        const result = await run(
          ['metatask', 'release', '--root', rootPinId, '--node', node, '--claim', claimPinId, '--from', slug],
          { timeoutMs: METATASK_WRITE_TIMEOUT_MS },
        )
        if (!result.ok) return commandFailure('metatask_release', result)
        return renderWriteData(result.data)
      } catch (error) {
        return thrownFailure('metatask_release', error)
      }
    },
  }

  const submit: HostToolDefinition = {
    name: 'metatask_submit',
    description:
      'Submit the work certificate for a node as the session acting OAC MetaBot. Pass the result object exactly '
      + 'as the node spec demands and WITHOUT any hash field — the daemon-side writer computes and embeds the '
      + 'protocol hashes, and your result object is forwarded untouched (no field pruning, no key reordering). '
      + 'TREE MODE: the node must be claim-held by you (claimPinId required); aggregate nodes also need childIds '
      + '(verified child submission pinIds). COMPETITIVE MODE: no claim exists — deps are enforced via '
      + 'parentRefs (depNodeId -> one existing submission pinId of this task on that dep); optimistic '
      + 'pipelining is reported by the writer in the result. attachment takes pin:// | metafile:// | '
      + 'metaapp:// artifact URIs (git-workspace nodes require a metafile:// bundle). Use supersedePinId to '
      + 'replace your earlier submission on the same node. Read the node contract with metatask_get before '
      + 'writing. Requires the OAC daemon running.',
    parameters: {
      type: 'object',
      properties: {
        rootPinId: { type: 'string', description: 'Task root pinId (64 lowercase hex + i0, 66 chars).' },
        node: { type: 'string', description: 'Node id the work certificate belongs to.' },
        result: {
          type: 'object',
          additionalProperties: true,
          description:
            'Result object WITHOUT a hash field; task-specific fields per the node spec. Forwarded untouched — '
            + 'the writer computes the hashes.',
        },
        claimPinId: {
          type: 'string',
          description: 'Tree mode: the claim pin returned by metatask_claim. Competitive mode: not needed; ignored when passed.',
        },
        contentType: { type: 'string', description: 'Recorded metadata only (never gates verification). Default application/json;utf-8.' },
        attachment: { type: 'string', description: 'Artifact URI: pin:// | metafile:// | metaapp://. git-workspace nodes require metafile://.' },
        childIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tree mode, aggregate nodes only: verified child submission pinIds. Refused in competitive mode — use parentRefs.',
        },
        parentRefs: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Competitive mode only: depNodeId -> one existing submission pinId of this task on that dep. Omit (or {}) on entry nodes.',
        },
        supersedePinId: {
          type: 'string',
          description: 'Your earlier submission pinId being replaced (tree: same claim cycle; competitive: your tip on the same node).',
        },
      },
      required: ['rootPinId', 'node', 'result'],
    },
    output: { schema: { type: 'string' }, render },
    timeoutMs: METATASK_WRITE_TIMEOUT_MS,
    execute: async (args: Record<string, unknown>, exec: HostToolExec) => {
      const rootPinId = textOf(args.rootPinId)
      if (!rootPinId) return toolError('metatask_submit', 'rootPinId is required.')
      const node = textOf(args.node)
      if (!node) return toolError('metatask_submit', 'node is required.')
      const result = args.result
      if (result === null || typeof result !== 'object' || Array.isArray(result)) {
        return toolError('metatask_submit', 'result must be an object (the work certificate).')
      }
      const resultObject = result as Record<string, unknown>
      // The writer deletes any caller hash before hashing, so passing one is
      // always a mistake — refuse it here with a readable message instead of
      // letting a confused agent spend a pin (design §4: implemented + tested).
      if ('hash' in resultObject) {
        return toolError('metatask_submit', 'the writer computes the hash — resend without `hash`.')
      }
      const slug = metataskActorSlug(host, hostAgent, exec)
      if (!slug) return toolError('metatask_submit', NO_ACTOR_MESSAGE)
      // Pass `result` through by reference: no reconstruction, no key
      // reordering — the writer canon depends on the untouched object.
      const payload: Record<string, unknown> = { root: rootPinId, node, result: resultObject }
      const claimPinId = textOf(args.claimPinId)
      if (claimPinId) payload.claimPinId = claimPinId
      const contentType = textOf(args.contentType)
      if (contentType) payload.contentType = contentType
      const attachment = textOf(args.attachment)
      if (attachment) payload.attachment = attachment
      if (args.childIds !== undefined) {
        if (!Array.isArray(args.childIds)) return toolError('metatask_submit', 'childIds must be an array of submission pinIds.')
        payload.childIds = args.childIds.map(String)
      }
      if (args.parentRefs !== undefined) {
        const parentRefs = args.parentRefs
        if (parentRefs === null || typeof parentRefs !== 'object' || Array.isArray(parentRefs)) {
          return toolError('metatask_submit', 'parentRefs must be an object of depNodeId -> submission pinId.')
        }
        payload.parentRefs = parentRefs
      }
      const supersedePinId = textOf(args.supersedePinId)
      if (supersedePinId) payload.supersedePinId = supersedePinId
      try {
        const outcome = await runMetabotWithPayloadFile(
          ['metatask', 'submit', '--from', slug],
          payload,
          '--request-file',
          [],
          run,
          { timeoutMs: METATASK_WRITE_TIMEOUT_MS },
        )
        if (!outcome.ok) return commandFailure('metatask_submit', outcome)
        return renderWriteData(outcome.data)
      } catch (error) {
        return thrownFailure('metatask_submit', error)
      }
    },
  }

  const verify: HostToolDefinition = {
    name: 'metatask_verify',
    description:
      'Cast an independent review vote on a submission as the session acting OAC MetaBot. Plugin-side gates, '
      + 'refused before any spend: verdict must be exactly "pass" or "fail" (anything else is rejected locally — '
      + 'never silently normalized to a pass vote); verdict=fail requires failReason; method must be non-empty '
      + 'and map to an actually-performed spec replay (parse the target per its declared bytes, re-run the '
      + 'spec, compare the hashes); semanticCheck is required non-empty (what you checked about meaning). '
      + 'Same-side rule: you must NOT review a submission whose submitter or the task publisher is on the '
      + 'local roster — pick another node; a same-side vote is refused by the writer and the refusal is '
      + 'surfaced verbatim. Requires the OAC daemon running.',
    parameters: {
      type: 'object',
      properties: {
        targetPinId: { type: 'string', description: 'Submission pinId being reviewed.' },
        verdict: {
          type: 'string',
          enum: ['pass', 'fail'],
          description: 'Exactly "pass" or "fail" — anything else is rejected locally before any spend.',
        },
        method: { type: 'string', description: 'What you replayed and how it maps to your verdict (e.g. "spec rerun pass; inner+outer hash match").' },
        semanticCheck: { type: 'string', description: 'The semantic check you performed (never empty — e.g. statement/definitions/direction correspondence).' },
        failReason: { type: 'string', description: 'REQUIRED when verdict=fail; cite the challenge pinId when overturning on challenge grounds.' },
        evidence: { type: 'string', description: 'Optional supporting evidence (bonus, not a requirement).' },
      },
      required: ['targetPinId', 'verdict', 'method', 'semanticCheck'],
    },
    output: { schema: { type: 'string' }, render },
    timeoutMs: METATASK_WRITE_TIMEOUT_MS,
    execute: async (args: Record<string, unknown>, exec: HostToolExec) => {
      const targetPinId = textOf(args.targetPinId)
      if (!targetPinId) return toolError('metatask_verify', 'targetPinId is required.')
      // Load-bearing local enum check: the daemon normalizes any non-"fail"
      // verdict to a PASS vote, so a typo must never reach the CLI.
      if (args.verdict !== 'pass' && args.verdict !== 'fail') {
        return toolError(
          'metatask_verify',
          `verdict must be exactly "pass" or "fail" (got ${JSON.stringify(args.verdict) ?? 'null'}) — `
          + 'a wrong-case value would be spent as a pass vote.',
        )
      }
      const verdict = args.verdict
      const method = textOf(args.method)
      if (!method) return toolError('metatask_verify', 'method is empty — a vote must map to an actually-performed replay.')
      const semanticCheck = textOf(args.semanticCheck)
      if (!semanticCheck) return toolError('metatask_verify', 'semantic_check is empty (the vote would not be counted).')
      const failReason = textOf(args.failReason)
      if (verdict === 'fail' && !failReason) {
        return toolError('metatask_verify', 'verdict=fail requires failReason (without it the vote is treated as invalid).')
      }
      const slug = metataskActorSlug(host, hostAgent, exec)
      if (!slug) return toolError('metatask_verify', NO_ACTOR_MESSAGE)
      const payload: Record<string, unknown> = { targetPinId, verdict, method, semanticCheck }
      if (verdict === 'fail') payload.failReason = failReason
      const evidence = textOf(args.evidence)
      if (evidence) payload.evidence = evidence
      try {
        const outcome = await runMetabotWithPayloadFile(
          ['metatask', 'verify', '--from', slug],
          payload,
          '--request-file',
          [],
          run,
          { timeoutMs: METATASK_WRITE_TIMEOUT_MS },
        )
        if (!outcome.ok) return commandFailure('metatask_verify', outcome)
        return renderWriteData(outcome.data)
      } catch (error) {
        return thrownFailure('metatask_verify', error)
      }
    },
  }

  return [list, get, replay, claim, release, submit, verify]
}

function isDuplicateToolError(error: unknown): boolean {
  return error instanceof Error && /already.*(registered|exists)|duplicate/i.test(error.message)
}

/** Register the MetaTask tools on the host global layer during plugin apply. */
export function bindMetataskToolInstall(ctx: HostContext): void {
  for (const definition of buildMetataskTools({ host: ctx, hostAgent: { ctx } })) {
    try {
      ctx.tools?.register(definition)
    } catch (error) {
      if (!isDuplicateToolError(error)) {
        ctx.logger?.warn?.(`[oac-dsh] metatask tool install failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
}
