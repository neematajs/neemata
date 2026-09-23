import { randomUUID } from 'node:crypto'

import type {
  ClaimedAttempt,
  ContinueRunCommand,
  TaskAttemptCommand,
} from '../../runtime/commands.ts'
import type {
  RunSnapshot,
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type {
  AttemptSummary,
  CreateAttemptInput,
  CreateNodeInput,
  CreateRunInput,
  DeadWorkflowCommand,
  EnsureChildAttemptParams,
  EnsureChildRunParams,
  EnsureNodeChildrenParams,
  Fenced,
  ListRunsFilter,
  NodeChildRef,
  NodeChildSummary,
  NodeSummary,
  PruneTerminalRunsParams,
  RunDetail,
  RunFamilyEntry,
  RunLease,
  RunSummary,
  TerminalRunStatus,
  WorkflowStore,
  WriteFence,
} from '../../runtime/store.ts'
import type { Timestamp } from '../../types/index.ts'
import type { WorkflowRedisClient } from './client.ts'
import type { FenceCall } from './fence.ts'
import type { Keys } from './keys.ts'
import {
  WorkflowRunConflictError,
  toStoredError,
} from '../../runtime/errors.ts'
import { isTerminalRunStatus } from '../../runtime/status.ts'
import { validateFailedRunRetry } from '../../runtime/store.ts'
import {
  RUN_TRANSITIONS,
  transitionSources,
} from '../../runtime/transitions.ts'
import { assertNotFenced, resolveWriteFence } from './fence.ts'
import {
  decode,
  encode,
  childKey as encodeChildKey,
  nodeKey,
  runSignature,
  sameValue,
  type Family,
  type StoredLease,
} from './state.ts'
import { StoreScripts, type ScriptName } from './store-scripts.ts'

const READ_BATCH_SIZE = 128
const DEFAULT_PRUNE_BATCH_SIZE = 100
const DEFAULT_PRUNE_STATUSES = [
  'completed',
  'cancelled',
  'failed',
] as const satisfies readonly TerminalRunStatus[]

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

export type StoreDelegates = {
  listDeadCommands(runId?: string): Promise<readonly DeadWorkflowCommand[]>
  listUnreapedDeadCommands: WorkflowStore['listUnreapedDeadCommands']
  markDeadCommandReaped(id: string): Promise<void>
  requeueDeadCommand(id: string): Promise<void>
  deleteCommands(runIds: ReadonlySet<string>): Promise<void>
  pruneDeadCommands(olderThan: Timestamp): Promise<void>
}

export type StoreOptions = {
  readonly client: WorkflowRedisClient
  readonly keys: Keys
  readonly terminalRetentionMs: number
  readonly delegates: StoreDelegates
}

export class StoreRuntime {
  readonly store: WorkflowStore
  readonly #client: WorkflowRedisClient
  readonly #keys: Keys
  readonly #terminalRetentionMs: number
  readonly #delegates: StoreDelegates
  readonly #scripts: StoreScripts

  constructor(options: StoreOptions) {
    this.#client = options.client
    this.#keys = options.keys
    this.#terminalRetentionMs = options.terminalRetentionMs
    this.#delegates = options.delegates
    this.#scripts = new StoreScripts(options.client)
    this.store = this.#createStore()
  }

  async createRun(
    input: CreateRunInput,
    startAt?: Timestamp,
  ): Promise<{
    readonly run: StoredRun
    readonly created: boolean
    readonly startAt: Timestamp | undefined
  }> {
    const normalized = await this.#normalizeRun(input)
    const run = this.#buildRun(normalized)
    const rootRunId = run.rootRunId
    let idempotencyKey = ''
    if (run.idempotencyKey) {
      idempotencyKey = this.#keys.idempotency(run.idempotencyKey)
    }
    let uniqueKey = ''
    let uniqueBehavior = ''
    if (run.unique) {
      uniqueKey = this.#keys.unique(run.unique.scope, run.unique.key)
      uniqueBehavior = run.unique.behavior
    }
    let encodedStartAt = ''
    if (startAt !== undefined) encodedStartAt = String(startAt)
    const result = scriptResult(
      await this.#scripts.run(
        'createRun',
        [
          this.#keys.family(rootRunId),
          this.#keys.familyRuns(rootRunId),
          this.#keys.familyOrders(rootRunId),
          this.#keys.familySignatures(rootRunId),
          this.#keys.activeRuns(),
          this.#keys.runSequence(),
          this.#keys.runWake(rootRunId),
        ],
        [
          encode(run),
          runSignature(normalized),
          this.#keys.runRoot(run.id),
          this.#keys.startDispatch(run.id),
          idempotencyKey,
          uniqueKey,
          uniqueBehavior,
          this.#keys.prefix,
          encodedStartAt,
        ],
      ),
    )
    if (result[0] === 'missing-family') {
      throw new Error(`Missing workflow run [${rootRunId}]`)
    }
    if (result[0] === 'terminal-family') {
      throw new Error(`Terminal workflow family [${rootRunId}]`)
    }
    const stored = decodeScriptValue<StoredRun>(result[1])
    let storedStartAt: Timestamp | undefined
    if (result[3]) storedStartAt = Number(result[3])
    if (result[0] === 'created') {
      return { run: stored, created: true, startAt: storedStartAt }
    }
    if (result[0] === 'idempotent') {
      if (runMatchesCreateInput(stored, normalized)) {
        return { run: stored, created: false, startAt: storedStartAt }
      }
      throw new Error(`Conflicting idempotent run [${input.workflowName}]`)
    }
    if (result[0] === 'joined') {
      return { run: stored, created: false, startAt: storedStartAt }
    }
    if (result[0] === 'conflict' && run.unique) {
      throw new WorkflowRunConflictError({
        runId: stored.id,
        status: stored.status,
        key: run.unique.key,
        scope: run.unique.scope,
      })
    }
    throw new Error(`Unexpected Redis create-run result [${result[0]}]`)
  }

  async #reopenFailedRun(params: { runId: string; expectedVersion: number }) {
    const rootRunId = await this.#requireRootRunId(params.runId)
    const stateKeys = this.#keys.familyStateKeys(rootRunId)
    const expected = await Promise.all([
      this.#client.hgetall(stateKeys[1]),
      this.#client.hgetall(stateKeys[2]),
      this.#client.hgetall(stateKeys[3]),
      this.#client.hgetall(stateKeys[4]),
    ])
    const runs = decodeRecord<StoredRun>(expected[0]!)
    const nodes = Object.values(decodeRecord<StoredNode>(expected[1]!))
    const childrenByKey = decodeRecord<StoredNodeChild>(expected[2]!)
    const children = Object.values(childrenByKey)
    const attempts = Object.values(decodeRecord<StoredAttempt>(expected[3]!))
    const snapshots: RunSnapshot[] = []
    for (const run of Object.values(runs)) {
      const runNodes = nodes.filter((node) => node.runId === run.id)
      const runChildren = children.filter((child) => child.runId === run.id)
      runChildren.sort(compareChildrenForDetail)
      const runAttempts = attempts.filter((attempt) => attempt.runId === run.id)
      snapshots.push({
        run,
        nodes: runNodes,
        children: runChildren,
        attempts: runAttempts,
      })
    }
    const reopening = validateFailedRunRetry(snapshots, params)
    const guards: { key: string; runId: string }[] = []
    const runIds: string[] = []
    for (const { run } of reopening) {
      runIds.push(run.id)
      if (run.unique) {
        guards.push({
          key: this.#keys.unique(run.unique.scope, run.unique.key),
          runId: run.id,
        })
      }
    }
    const root = runs[params.runId]!
    const date = Date.now()
    let attempt: StoredAttempt | undefined
    let command: ContinueRunCommand | TaskAttemptCommand = {
      kind: 'continueRun',
      runId: root.id,
      workflowName: root.workflowName,
    }
    let wakeKind: 'continue' | 'task' = 'continue'
    if (root.kind === 'task') {
      const child = childrenByKey[encodeChildKey(root.id, '$task', '$self')]!
      const previous = attempts.find(
        (entry) =>
          entry.runId === root.id &&
          entry.nodeName === child.nodeName &&
          entry.childKey === child.childKey &&
          entry.attemptNumber === child.attemptCount,
      )!
      const leaseToken = randomUUID()
      attempt = {
        id: randomUUID(),
        runId: root.id,
        nodeName: '$task',
        childKey: '$self',
        status: 'started',
        leaseToken,
        attemptNumber: child.attemptCount + 1,
        retryAttemptNumber: 1,
        input: previous.input,
        idempotencyKey: previous.idempotencyKey,
        dispatchedAt: date,
      }
      command = {
        kind: 'taskAttempt',
        runId: root.id,
        workflowName: root.workflowName,
        taskName: root.taskName ?? root.name,
        nodeName: '$task',
        childKey: '$self',
        attemptId: attempt.id,
        leaseToken,
        input: attempt.input,
        idempotencyKey: attempt.idempotencyKey,
      }
      wakeKind = 'task'
    }
    const continueQueue = this.#keys.queue('continue')
    const attemptQueue = this.#keys.queue('attempt')
    // Validate the shared contract first, then compare every observed record
    // inside Lua so cleanup, competing retries and execution cannot interleave.
    const result = scriptResult(
      await this.#scripts.run(
        'reopenFailedRun',
        [
          ...stateKeys,
          this.#keys.activeRuns(),
          this.#keys.terminalRuns(),
          continueQueue.items,
          continueQueue.ready,
          continueQueue.claimed,
          continueQueue.dead,
          continueQueue.dedup,
          attemptQueue.items,
          attemptQueue.ready,
          attemptQueue.claimed,
          attemptQueue.dead,
          attemptQueue.dedup,
          this.#keys.runWake(rootRunId),
          this.#keys.commandWake(wakeKind),
        ],
        [
          JSON.stringify(expected),
          JSON.stringify(runIds),
          JSON.stringify(guards),
          encode(attempt ?? null),
          encode({
            id: randomUUID(),
            payload: command,
            rootRunId,
            deliveryCount: 0,
            createdAt: date,
            createdAtScore: date,
          }),
          root.id,
          this.#keys.prefix,
        ],
      ),
    )
    if (result[0] === 'conflict') {
      const holder = decodeScriptValue<StoredRun>(result[1])
      throw new WorkflowRunConflictError({
        runId: holder.id,
        status: holder.status,
        key: holder.unique!.key,
        scope: holder.unique!.scope,
      })
    }
    if (result[0] === 'busy') throw new Error(`Run [${result[1]}] is busy`)
    if (result[0] === 'claimed')
      throw new Error(`Run [${result[1]}] has an active attempt`)
    if (result[0] !== 'updated')
      throw new Error(`Stale retry version for run [${root.id}]`)
    return decodeScriptValue<StoredRun>(result[1])
  }

  async #normalizeRun(input: CreateRunInput): Promise<CreateRunInput> {
    if (input.rootRunId !== undefined || input.parentRunId === undefined) {
      return input
    }
    const parent = await this.loadRun(input.parentRunId)
    if (!parent) return input
    return { ...input, rootRunId: parent.rootRunId }
  }

  async loadRun(runId: string): Promise<StoredRun | undefined> {
    const rootRunId = await this.#client.get(this.#keys.runRoot(runId))
    if (!rootRunId) return undefined
    const raw = await this.#client.hget(this.#keys.familyRuns(rootRunId), runId)
    if (!raw) return undefined
    return decode<StoredRun>(raw)
  }

  #buildRun(input: CreateRunInput): StoredRun {
    const date = Date.now()
    const id = randomUUID()
    const run: Mutable<StoredRun> = {
      id,
      kind: input.kind ?? 'workflow',
      name: input.name ?? input.taskName ?? input.workflowName,
      workflowName: input.workflowName,
      status: 'queued',
      input: input.input,
      rootRunId: input.rootRunId ?? id,
      tags: input.tags ?? {},
      version: 1,
      activeSince: date,
      createdAt: date,
      updatedAt: date,
    }
    if (input.taskName !== undefined) run.taskName = input.taskName
    if (input.parentRunId !== undefined) run.parentRunId = input.parentRunId
    if (input.parentNodeName !== undefined) {
      run.parentNodeName = input.parentNodeName
    }
    if (input.idempotencyKey !== undefined) {
      run.idempotencyKey = input.idempotencyKey
    }
    if (input.unique !== undefined) run.unique = input.unique
    return run
  }

  #createStore(): WorkflowStore {
    return {
      reopenFailedRun: (params) => this.#reopenFailedRun(params),
      createRun: async (input) => {
        const result = await this.createRun(input)
        return result.run
      },
      listRuns: (filter = {}) => this.#listRuns(filter),
      listRunSummaries: async (filter = {}) => {
        const result = await this.#listRuns(filter)
        const summaries = await this.#loadRunSummaries(result.runs)
        const response: { runs: RunSummary[]; nextCursor?: string } = {
          runs: summaries,
        }
        if (result.nextCursor !== undefined) {
          response.nextCursor = result.nextCursor
        }
        return response
      },
      pruneTerminalRuns: (params) => this.#pruneTerminalRuns(params),
      deleteRun: (runId) => this.#deleteRun(runId),
      listDeadCommands: (params) =>
        this.#delegates.listDeadCommands(params?.runId),
      listUnreapedDeadCommands: (params) =>
        this.#delegates.listUnreapedDeadCommands(params),
      markDeadCommandReaped: (id) => this.#delegates.markDeadCommandReaped(id),
      requeueDeadCommand: (id) => this.#delegates.requeueDeadCommand(id),
      acquireRunLease: (params) => this.#acquireRunLease(params),
      renewRunLease: (lease, leaseMs) => this.#renewRunLease(lease, leaseMs),
      releaseRunLease: (lease) => this.#releaseRunLease(lease),
      loadRunSnapshot: (runId) => this.#loadRunSnapshot(runId),
      loadRunDetail: (runId) => this.#loadRunDetail(runId),
      loadNodeSnapshot: (params) =>
        this.#loadNodeSnapshot(params.runId, params.nodeName),
      listRunFamily: (runId) => this.#listRunFamily(runId),
      loadRuns: async (runIds) => {
        const seen = new Set<string>()
        const pending: Promise<StoredRun | undefined>[] = []
        for (const runId of runIds) {
          if (seen.has(runId)) continue
          seen.add(runId)
          pending.push(this.loadRun(runId))
        }
        const loaded = await Promise.all(pending)
        const runs: StoredRun[] = []
        for (const run of loaded) {
          if (run) runs.push(run)
        }
        return runs
      },
      createNode: (input) => this.#createNode(input),
      setNodeInput: (params) => this.#setNodeInput(params),
      selectNodeCase: (params) =>
        this.#updateNode(
          params.runId,
          params.nodeName,
          'nodeCase',
          { selectedCase: params.caseKey },
          params.fence,
        ),
      ensureNodeChildren: (params) => this.#ensureNodeChildren(params),
      ensureChildRun: (params) => this.#ensureChildRun(params),
      ensureChildAttempt: (params) => this.#ensureChildAttempt(params),
      createAttempt: (input) => this.#createAttempt(input),
      ...this.#attemptSettlement(),
      completeNodeChild: (params) =>
        this.#updateChild(
          params,
          { status: 'completed', output: params.output },
          params.fence,
        ),
      failNodeChild: (params) =>
        this.#updateChild(
          params,
          { status: 'failed', error: toStoredError(params.error) },
          params.fence,
        ),
      loadNodeChildren: async (params) => {
        const family = await this.#loadFamilyByRun(params.runId)
        if (!family) return { children: [], attempts: [] }
        const children = Object.values(family.children).filter(
          (child) =>
            child.runId === params.runId && child.nodeName === params.nodeName,
        )
        children.sort(compareChildren)
        const attempts = Object.values(family.attempts).filter(
          (attempt) =>
            attempt.runId === params.runId &&
            attempt.nodeName === params.nodeName,
        )
        attempts.sort(compareAttempts)
        return {
          children,
          attempts,
        }
      },
      completeNode: (params) =>
        this.#updateNode(
          params.runId,
          params.nodeName,
          'nodeTransition',
          { status: 'completed', output: params.output },
          params.fence,
        ),
      failNode: (params) =>
        this.#updateNode(
          params.runId,
          params.nodeName,
          'nodeTransition',
          { status: 'failed', error: toStoredError(params.error) },
          params.fence,
        ),
      waitNode: (params) =>
        this.#updateNode(
          params.runId,
          params.nodeName,
          'nodeWait',
          { status: 'waiting' },
          params.fence,
        ),
      markRunRunning: ({ runId, fence }) =>
        this.#transitionRun(runId, 'running', fence),
      markRunWaiting: ({ runId, fence }) =>
        this.#transitionRun(runId, 'waiting', fence),
      completeRun: ({ runId, output, fence }) =>
        this.#terminalRun(runId, { status: 'completed', output }, fence),
      failRun: ({ runId, error, fence }) =>
        this.#terminalRun(
          runId,
          { status: 'failed', error: toStoredError(error) },
          fence,
        ),
      requestRunCancellation: ({ runId, fence }) =>
        this.#requestCancellation(runId, fence),
      cancelRun: ({ runId, fence }) =>
        this.#terminalRun(runId, { status: 'cancelled' }, fence),
      cancelNode: ({ runId, nodeName, fence }) =>
        this.#updateNode(
          runId,
          nodeName,
          'nodeTransition',
          { status: 'cancelled' },
          fence,
        ),
      cancelNonTerminalRunNodes: ({ runId, fence }) =>
        this.#cancelNonTerminalRunNodes(runId, fence),
    }
  }

  async #listRuns(filter: ListRunsFilter) {
    const limit = filter.limit ?? Number.POSITIVE_INFINITY
    let offset = 0
    if (filter.cursor) offset = Number.parseInt(filter.cursor, 10)
    if (filter.limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
      return { runs: [] }
    }
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`Invalid run list cursor [${filter.cursor}]`)
    }
    const page: StoredRun[] = []
    let cursor = '+inf'
    let matched = 0
    do {
      // Sparse filters still scan full pages after the initial small request.
      const size =
        cursor === '+inf'
          ? Math.min(READ_BATCH_SIZE, offset + limit + 1)
          : READ_BATCH_SIZE
      const result = scriptResult(
        await this.#scripts.run(
          'listRuns',
          [
            this.#keys.orderedRuns(),
            this.#keys.activeRuns(),
            this.#keys.terminalRuns(),
          ],
          [cursor, String(size), this.#keys.prefix],
        ),
      )
      cursor = result[0]!
      for (const raw of result.slice(1)) {
        const run = decode<StoredRun>(raw)
        if (!runMatchesFilter(run, filter)) continue
        if (matched++ < offset) continue
        if (page.length === limit)
          return { runs: page, nextCursor: String(offset + page.length) }
        page.push(run)
      }
    } while (cursor !== '')
    return { runs: page }
  }

  async #loadRunSummaries(runs: readonly StoredRun[]): Promise<RunSummary[]> {
    const summaries: RunSummary[] = []
    for (let offset = 0; offset < runs.length; offset += READ_BATCH_SIZE) {
      const batch = runs.slice(offset, offset + READ_BATCH_SIZE)
      const counts = batch.map(() => ({ total: 0, completed: 0 }))
      const encoded = JSON.stringify(
        batch.map(({ id, rootRunId }) => ({ id, rootRunId })),
      )
      let position = '1'
      let nodePosition = '1'
      do {
        const result = scriptResult(
          await this.#scripts.run(
            'summarizeRuns',
            [],
            [
              this.#keys.prefix,
              encoded,
              position,
              nodePosition,
              String(READ_BATCH_SIZE),
            ],
          ),
        )
        position = result[0]!
        nodePosition = result[1]!
        for (let index = 2; index < result.length; index += 3) {
          const count = counts[Number(result[index]) - 1]!
          count.total += Number(result[index + 1])
          count.completed += Number(result[index + 2])
        }
      } while (position !== '0')
      for (let index = 0; index < batch.length; index += 1) {
        const { input: _input, output: _output, ...run } = batch[index]!
        summaries.push({
          ...run,
          nodesTotal: counts[index]!.total,
          nodesCompleted: counts[index]!.completed,
        })
      }
    }
    return summaries
  }

  async #loadFamilyByRun(runId: string) {
    const rootRunId = await this.#client.get(this.#keys.runRoot(runId))
    if (!rootRunId) return undefined
    return this.#loadFamily(rootRunId)
  }

  async #loadFamily(rootRunId: string) {
    const [meta, runs, nodes, children, attempts, indexes] = await Promise.all([
      this.#client.hgetall(this.#keys.family(rootRunId)),
      this.#client.hgetall(this.#keys.familyRuns(rootRunId)),
      this.#client.hgetall(this.#keys.familyNodes(rootRunId)),
      this.#client.hgetall(this.#keys.familyChildren(rootRunId)),
      this.#client.hgetall(this.#keys.familyAttempts(rootRunId)),
      this.#client.hgetall(this.#keys.familyIndexes(rootRunId)),
    ])
    if (!meta.rootRunId) return undefined
    const runIds = decode<string[]>(meta.runIds ?? '[]')
    const nodeFields: string[] = []
    const childFields: string[] = []
    const attemptFields: string[] = []
    for (const runId of runIds) {
      appendEncodedFields(indexes[`nodes:${runId}`], nodeFields)
    }
    for (const nodeField of nodeFields) {
      appendEncodedFields(indexes[`children:${nodeField}`], childFields)
      appendEncodedFields(indexes[`attempts:${nodeField}`], attemptFields)
    }
    return {
      rootRunId,
      runs: decodeOrderedRecord<StoredRun>(runs, runIds),
      nodes: decodeOrderedRecord<StoredNode>(nodes, nodeFields),
      children: decodeOrderedRecord<StoredNodeChild>(children, childFields),
      attempts: decodeOrderedRecord<StoredAttempt>(attempts, attemptFields),
    } satisfies Family
  }

  async #loadRunSnapshot(runId: string): Promise<RunSnapshot | undefined> {
    const family = await this.#loadFamilyByRun(runId)
    if (!family) return undefined
    const run = family.runs[runId]
    if (!run) return undefined
    const nodes = Object.values(family.nodes).filter(
      (node) => node.runId === runId,
    )
    const children = Object.values(family.children).filter(
      (child) => child.runId === runId,
    )
    const attempts = Object.values(family.attempts).filter(
      (attempt) => attempt.runId === runId,
    )
    return {
      run,
      nodes,
      children,
      attempts,
    }
  }

  async #loadRunDetail(runId: string): Promise<RunDetail | undefined> {
    const family = await this.#loadFamilyByRun(runId)
    if (!family) return undefined
    const run = family.runs[runId]
    if (!run) return undefined
    const children: StoredNodeChild[] = []
    const childRunIds = new Set<string>()
    for (const child of Object.values(family.children)) {
      if (child.runId !== runId) continue
      children.push(child)
      if (child.childRunId) childRunIds.add(child.childRunId)
    }
    children.sort(compareChildrenForDetail)
    const nodes: NodeSummary[] = []
    for (const node of Object.values(family.nodes)) {
      if (node.runId === runId) nodes.push(nodeSummary(node))
    }
    const childSummaries = children.map(childSummary)
    const attempts = Object.values(family.attempts).filter(
      (attempt) => attempt.runId === runId,
    )
    attempts.sort(compareAttempts)
    const attemptSummaries = attempts.map(attemptSummary)
    const childRuns = Object.values(family.runs).filter((run) =>
      childRunIds.has(run.id),
    )
    childRuns.sort(compareRunsOldest)
    const childRunSummaries = childRuns.map((child) =>
      runSummary(family, child),
    )
    const summary = runSummary(family, run)
    return {
      run: summary,
      nodes,
      children: childSummaries,
      attempts: attemptSummaries,
      childRuns: childRunSummaries,
    }
  }

  async #loadNodeSnapshot(runId: string, nodeName: string) {
    const family = await this.#loadFamilyByRun(runId)
    if (!family) return undefined
    const node = family.nodes[nodeKey(runId, nodeName)]
    if (!node) return undefined
    const children = Object.values(family.children).filter(
      (child) => child.runId === runId && child.nodeName === nodeName,
    )
    children.sort(compareChildren)
    const attempts = Object.values(family.attempts).filter(
      (attempt) => attempt.runId === runId && attempt.nodeName === nodeName,
    )
    attempts.sort(compareAttempts)
    return {
      node,
      children,
      attempts,
    }
  }

  async #listRunFamily(runId: string): Promise<readonly RunFamilyEntry[]> {
    const family = await this.#loadFamilyByRun(runId)
    if (!family || !family.runs[runId]) return []
    const origins = new Map<string, { nodeName: string; childKey: string }>()
    for (const child of Object.values(family.children)) {
      if (child.childRunId && !origins.has(child.childRunId)) {
        origins.set(child.childRunId, {
          nodeName: child.nodeName,
          childKey: child.childKey,
        })
      }
    }
    const runs = Object.values(family.runs)
    runs.sort(compareRunsOldest)
    return runs.map((run) => {
      const origin = origins.get(run.id)
      const summary = runSummary(family, run)
      return origin ? { run: summary, origin } : { run: summary }
    })
  }

  async #createNode(input: Fenced<CreateNodeInput>) {
    const rootRunId = await this.#requireRootRunId(input.runId, input.fence)
    const fence = await this.#resolveFence(input.fence, input.runId, rootRunId)
    const date = Date.now()
    const node: StoredNode = {
      runId: input.runId,
      name: input.name,
      kind: input.kind,
      status: 'pending',
      version: 1,
      createdAt: date,
      updatedAt: date,
    }
    const result = scriptResult(
      await this.#runFenced(
        'createNode',
        fence,
        [
          this.#keys.familyNodes(rootRunId),
          this.#keys.familyIndexes(rootRunId),
          this.#keys.runWake(rootRunId),
          this.#keys.familyRuns(rootRunId),
        ],
        [nodeKey(input.runId, input.name), encode(node), input.runId],
      ),
    )
    if (result[0] === 'missing-run') {
      throw new Error(`Missing workflow run [${input.runId}]`)
    }
    return decodeScriptValue<StoredNode>(result[1])
  }

  async #updateNode(
    runId: string,
    nodeName: string,
    mode: string,
    changes: Partial<StoredNode>,
    fence: WriteFence | undefined,
  ) {
    const rootRunId = await this.#rootRunId(runId)
    if (!rootRunId) return this.#assertFence(fence)
    const result = await this.#updateRecord<StoredNode>(
      await this.#resolveFence(fence, runId, rootRunId),
      this.#keys.familyNodes(rootRunId),
      this.#keys.runWake(rootRunId),
      nodeKey(runId, nodeName),
      mode,
      changes,
    )
    if (result.code === 'conflict') {
      throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
    }
    return result.value
  }

  async #setNodeInput(
    params: Fenced<{
      readonly runId: string
      readonly nodeName: string
      readonly input: unknown
    }>,
  ) {
    const node = await this.#updateNode(
      params.runId,
      params.nodeName,
      'nodeInput',
      { input: params.input },
      params.fence,
    )
    if (node) return node
    throw new Error(`Missing node [${params.runId}.${params.nodeName}]`)
  }

  async #ensureNodeChildren(params: Fenced<EnsureNodeChildrenParams>) {
    const rootRunId = await this.#requireRootRunId(params.runId, params.fence)
    const fence = await this.#resolveFence(
      params.fence,
      params.runId,
      rootRunId,
    )
    const nodeField = nodeKey(params.runId, params.nodeName)
    const indexField = `children:${nodeField}`
    const date = Date.now()
    const created: StoredNodeChild[] = []
    const rows: { field: string; raw: string }[] = []
    for (const input of params.children) {
      const child: Mutable<StoredNodeChild> = {
        runId: params.runId,
        nodeName: params.nodeName,
        childKey: input.childKey,
        kind: input.kind,
        status: 'pending',
        ordinal: input.ordinal ?? 0,
        attemptCount: 0,
        version: 1,
        createdAt: date,
        updatedAt: date,
      }
      if (input.itemKey !== undefined) child.itemKey = input.itemKey
      if (input.item !== undefined) child.item = input.item
      created.push(child)
      rows.push({
        field: encodeChildKey(params.runId, params.nodeName, input.childKey),
        raw: encode(child),
      })
    }
    const result = scriptResult(
      await this.#runFenced(
        'ensureChildren',
        fence,
        [
          this.#keys.familyNodes(rootRunId),
          this.#keys.familyChildren(rootRunId),
          this.#keys.familyIndexes(rootRunId),
          this.#keys.runWake(rootRunId),
        ],
        [nodeField, indexField, encode(rows)],
      ),
    )
    if (result[0] === 'missing-node') {
      throw new Error(`Missing node [${params.runId}.${params.nodeName}]`)
    }
    if (result[0] === 'created') {
      created.sort(compareChildren)
      return { children: created, created: true }
    }
    const fields = decodeScriptValue<string[]>(result[1])
    const existing: StoredNodeChild[] = []
    if (fields.length > 0) {
      const raws = await this.#client.hmget(
        this.#keys.familyChildren(rootRunId),
        ...fields,
      )
      for (const raw of raws) {
        if (raw) existing.push(decode<StoredNodeChild>(raw))
      }
    }
    if (!nodeChildrenMatch(existing, params)) {
      throw new Error(
        `Conflicting node children [${params.runId}.${params.nodeName}]`,
      )
    }
    existing.sort(compareChildren)
    return { children: existing, created: false }
  }

  async #ensureChildRun(params: Fenced<EnsureChildRunParams>) {
    const rootRunId = await this.#requireRootRunId(params.runId, params.fence)
    const fence = await this.#resolveFence(
      params.fence,
      params.runId,
      rootRunId,
    )
    const input: Mutable<CreateRunInput> = {
      kind: params.childKind,
      name: params.childName,
      workflowName: params.childName,
      input: params.input,
      parentRunId: params.runId,
      parentNodeName: params.nodeName,
      rootRunId: params.rootRunId,
    }
    if (params.childKind === 'task') input.taskName = params.childName
    if (params.tags !== undefined) input.tags = params.tags
    if (params.idempotencyKey !== undefined) {
      input.idempotencyKey = params.idempotencyKey
    }
    const childRun = this.#buildRun(input)
    let idempotencyKey = ''
    if (params.idempotencyKey) {
      idempotencyKey = this.#keys.idempotency(params.idempotencyKey)
    }
    const result = scriptResult(
      await this.#runFenced(
        'createChildRun',
        fence,
        [
          this.#keys.family(rootRunId),
          this.#keys.familyRuns(rootRunId),
          this.#keys.familyChildren(rootRunId),
          this.#keys.familyOrders(rootRunId),
          this.#keys.familySignatures(rootRunId),
          this.#keys.activeRuns(),
          this.#keys.runSequence(),
          this.#keys.runWake(rootRunId),
        ],
        [
          encodeChildKey(params.runId, params.nodeName, params.childKey),
          encode(childRun),
          runSignature(input),
          this.#keys.runRoot(childRun.id),
          this.#keys.startDispatch(childRun.id),
          idempotencyKey,
          String(Date.now()),
          this.#keys.prefix,
          params.cancellation ?? '',
        ],
      ),
    )
    const reference = childRef(params.runId, params.nodeName, params.childKey)
    if (result[0] === 'missing-child') {
      throw new Error(`Missing node child [${reference}]`)
    }
    if (result[0] === 'missing-run') throw new Error('Missing child run')
    if (result[0] === 'terminal-child') {
      throw new Error(
        `Terminal node child [${reference}] cannot start child run`,
      )
    }
    if (result[0] === 'terminal-family') {
      throw new Error(`Terminal workflow family [${rootRunId}]`)
    }
    if (result[0] === 'conflict') {
      throw new Error(`Conflicting child run [${reference}]`)
    }
    return {
      child: decodeScriptValue<StoredNodeChild>(result[1]),
      childRun: decodeScriptValue<StoredRun>(result[2]),
      created: result[0] === 'created',
    }
  }

  #ensureChildAttempt(params: Fenced<EnsureChildAttemptParams>) {
    return this.#createChildAttempt(params, true)
  }

  async #createAttempt(input: Fenced<CreateAttemptInput>) {
    const result = await this.#createChildAttempt(input, false)
    return result.attempt
  }

  async #createChildAttempt(
    input: Fenced<CreateAttemptInput | EnsureChildAttemptParams>,
    ensure: boolean,
  ) {
    const rootRunId = await this.#requireRootRunId(input.runId, input.fence)
    const fence = await this.#resolveFence(input.fence, input.runId, rootRunId)
    const childField = encodeChildKey(
      input.runId,
      input.nodeName,
      input.childKey,
    )
    const nodeField = nodeKey(input.runId, input.nodeName)
    const attempt: Mutable<StoredAttempt> = {
      id: randomUUID(),
      runId: input.runId,
      nodeName: input.nodeName,
      childKey: input.childKey,
      status: 'started',
      leaseToken: randomUUID(),
      attemptNumber: 0,
      retryAttemptNumber: 1,
      input: input.input,
      dispatchedAt: Date.now(),
    }
    if (input.idempotencyKey !== undefined) {
      attempt.idempotencyKey = input.idempotencyKey
    }
    const result = scriptResult(
      await this.#runFenced(
        'createAttempt',
        fence,
        [
          this.#keys.family(rootRunId),
          this.#keys.familyChildren(rootRunId),
          this.#keys.familyNodes(rootRunId),
          this.#keys.familyAttempts(rootRunId),
          this.#keys.familyIndexes(rootRunId),
          this.#keys.runWake(rootRunId),
        ],
        [
          childField,
          nodeField,
          encode(attempt),
          attempt.id,
          this.#keys.attemptRoot(attempt.id),
          rootRunId,
          `attempts:${nodeField}`,
          ensure ? '1' : '0',
          String(Date.now()),
          ('after' in input ? input.after : undefined) ?? '',
        ],
      ),
    )
    const reference = childRef(input.runId, input.nodeName, input.childKey)
    if (result[0] === 'missing-child') {
      throw new Error(`Missing node child [${reference}]`)
    }
    if (result[0] === 'missing-attempt') {
      throw new Error(`Missing node child attempt [${reference}]`)
    }
    if (result[0] === 'terminal-child') {
      throw new Error(
        `Terminal node child [${reference}] cannot create attempt`,
      )
    }
    return {
      attempt: decodeScriptValue<StoredAttempt>(result[1]),
      created: result[0] === 'created',
    }
  }

  /**
   * The attempt's own token never rotates, so it cannot tell a worker whose
   * queue claim was taken over from the new claimant. Settling through this
   * store additionally requires the claim to still be the queue item's.
   */
  claimScopedStore(store: WorkflowStore, claim: ClaimedAttempt): WorkflowStore {
    return { ...store, ...this.#attemptSettlement(claim) }
  }

  #attemptSettlement(
    claim?: ClaimedAttempt,
  ): Pick<
    WorkflowStore,
    'completeCurrentAttempt' | 'failCurrentAttempt' | 'timeoutCurrentAttempt'
  > {
    return {
      completeCurrentAttempt: (params) =>
        this.#settleAttempt(
          params.attemptId,
          params.leaseToken,
          { status: 'completed', output: params.output },
          true,
          claim,
          params.fence,
        ),
      failCurrentAttempt: (params) =>
        this.#settleAttempt(
          params.attemptId,
          params.leaseToken,
          { status: 'failed', error: toStoredError(params.error) },
          false,
          claim,
          params.fence,
        ),
      timeoutCurrentAttempt: (params) =>
        this.#settleAttempt(
          params.attemptId,
          params.leaseToken,
          { status: 'timedOut', error: toStoredError(params.error) },
          false,
          claim,
          params.fence,
        ),
    }
  }

  async #settleAttempt(
    attemptId: string,
    leaseToken: string,
    settled: Pick<StoredAttempt, 'status'> & Partial<StoredAttempt>,
    completeChild: boolean,
    claim: ClaimedAttempt | undefined,
    writeFence: WriteFence | undefined,
  ) {
    const rootRunId = await this.#client.get(this.#keys.attemptRoot(attemptId))
    if (!rootRunId) return this.#assertFence(writeFence)
    const raw = await this.#client.hget(
      this.#keys.familyAttempts(rootRunId),
      attemptId,
    )
    if (!raw) return this.#assertFence(writeFence)
    const attempt = decode<StoredAttempt>(raw)
    const fence = await this.#resolveFence(writeFence, attempt.runId, rootRunId)
    const childField = encodeChildKey(
      attempt.runId,
      attempt.nodeName,
      attempt.childKey,
    )
    const result = scriptResult(
      await this.#runFenced(
        'settleAttempt',
        fence,
        [
          this.#keys.familyAttempts(rootRunId),
          this.#keys.familyChildren(rootRunId),
          this.#keys.runWake(rootRunId),
          this.#keys.queue('attempt').items,
        ],
        [
          attemptId,
          leaseToken,
          childField,
          encode(settled),
          String(Date.now()),
          completeChild ? '1' : '0',
          claim?.id ?? '',
          claim?.leaseToken ?? '',
        ],
      ),
    )
    if (result[0] === 'stale') return undefined
    return decodeScriptValue<StoredAttempt>(result[1])
  }

  async #updateChild(
    { runId, nodeName, childKey }: NodeChildRef,
    changes: Partial<StoredNodeChild>,
    fence: WriteFence | undefined,
  ) {
    const rootRunId = await this.#rootRunId(runId)
    if (!rootRunId) return this.#assertFence(fence)
    const result = await this.#updateRecord<StoredNodeChild>(
      await this.#resolveFence(fence, runId, rootRunId),
      this.#keys.familyChildren(rootRunId),
      this.#keys.runWake(rootRunId),
      encodeChildKey(runId, nodeName, childKey),
      'childTransition',
      changes,
    )
    return result.value
  }

  async #transitionRun(
    runId: string,
    status: 'running' | 'waiting',
    fence: WriteFence | undefined,
  ) {
    const rootRunId = await this.#rootRunId(runId)
    if (!rootRunId) return this.#assertFence(fence)
    const result = await this.#updateRecord<StoredRun>(
      await this.#resolveFence(fence, runId, rootRunId),
      this.#keys.familyRuns(rootRunId),
      this.#keys.runWake(rootRunId),
      runId,
      'runTransition',
      { status },
      transitionSources(RUN_TRANSITIONS, status),
    )
    return result.value
  }

  async #terminalRun(
    runId: string,
    terminal: Pick<StoredRun, 'status'> & Partial<StoredRun>,
    writeFence: WriteFence | undefined,
  ) {
    const run = await this.loadRun(runId)
    if (!run) return this.#assertFence(writeFence)
    const fence = await this.#resolveFence(writeFence, runId, run.rootRunId)
    let uniqueKey = ''
    if (run.unique?.scope === 'active') {
      uniqueKey = this.#keys.unique('active', run.unique.key)
    }
    const stateKeys = this.#keys.familyStateKeys(run.rootRunId)
    const result = scriptResult(
      await this.#runFenced(
        'terminalRun',
        fence,
        [
          this.#keys.family(run.rootRunId),
          this.#keys.familyRuns(run.rootRunId),
          this.#keys.activeRuns(),
          this.#keys.terminalRuns(),
          this.#keys.runWake(run.rootRunId),
          ...stateKeys,
        ],
        [
          runId,
          encode(terminal),
          String(Date.now()),
          '',
          String(this.#terminalRetentionMs),
          uniqueKey,
          this.#keys.orderedRuns(),
        ],
      ),
    )
    if (result[0] === 'missing') return undefined
    return decodeScriptValue<StoredRun>(result[1])
  }

  async #requestCancellation(runId: string, fence: WriteFence | undefined) {
    const rootRunId = await this.#rootRunId(runId)
    if (!rootRunId) return this.#assertFence(fence)
    const result = await this.#updateRecord<StoredRun>(
      await this.#resolveFence(fence, runId, rootRunId),
      this.#keys.familyRuns(rootRunId),
      this.#keys.runWake(rootRunId),
      runId,
      'runCancellation',
      { status: 'cancelling' },
    )
    if (result.value) {
      await this.#client.publish(this.#keys.cancellationWake(runId), '1')
    }
    return result.value
  }

  async #cancelNonTerminalRunNodes(
    runId: string,
    writeFence: WriteFence | undefined,
  ) {
    const rootRunId = await this.#requireRootRunId(runId, writeFence)
    const fence = await this.#resolveFence(writeFence, runId, rootRunId)
    const result = await this.#runFenced(
      'cancelNodes',
      fence,
      [
        this.#keys.familyNodes(rootRunId),
        this.#keys.familyChildren(rootRunId),
        this.#keys.familyIndexes(rootRunId),
        this.#keys.runWake(rootRunId),
        this.#keys.familyAttempts(rootRunId),
      ],
      [runId, String(Date.now())],
    )
    if (typeof result !== 'string') return []
    return decode<StoredNode[]>(result)
  }

  async #acquireRunLease(params: { runId: string; leaseMs: number }) {
    const rootRunId = await this.#rootRunId(params.runId)
    if (!rootRunId) return undefined
    const lease = {
      runId: params.runId,
      leaseToken: randomUUID(),
      version: 0,
    }
    const result = scriptResult(
      await this.#scripts.run(
        'lease',
        [
          this.#keys.familyRuns(rootRunId),
          this.#keys.familyLeases(rootRunId),
          this.#keys.runWake(rootRunId),
        ],
        ['acquire', params.runId, '', String(params.leaseMs), encode(lease)],
      ),
    )
    if (result[0] !== 'updated') return undefined
    return decodeScriptValue<StoredLease>(result[1])
  }

  async #renewRunLease(lease: RunLease, leaseMs: number) {
    const rootRunId = await this.#rootRunId(lease.runId)
    if (!rootRunId) return undefined
    const result = scriptResult(
      await this.#scripts.run(
        'lease',
        [
          this.#keys.familyRuns(rootRunId),
          this.#keys.familyLeases(rootRunId),
          this.#keys.runWake(rootRunId),
        ],
        ['renew', lease.runId, lease.leaseToken, String(leaseMs), '', ''],
      ),
    )
    if (result[0] !== 'updated') return undefined
    return decodeScriptValue<StoredLease>(result[1])
  }

  async #releaseRunLease(lease: RunLease) {
    const rootRunId = await this.#rootRunId(lease.runId)
    if (!rootRunId) return
    await this.#scripts.run(
      'lease',
      [
        this.#keys.familyRuns(rootRunId),
        this.#keys.familyLeases(rootRunId),
        this.#keys.runWake(rootRunId),
      ],
      ['release', lease.runId, lease.leaseToken, '', '', ''],
    )
  }

  async #updateRecord<T>(
    fence: FenceCall,
    hash: string,
    wake: string,
    field: string,
    mode: string,
    changes: Partial<T>,
    allowedSources: readonly string[] = [],
  ): Promise<{ code: string; value: T | undefined }> {
    const result = scriptResult(
      await this.#runFenced(
        'updateRecord',
        fence,
        [hash, wake],
        [
          field,
          mode,
          encode(changes),
          String(Date.now()),
          encode(allowedSources),
        ],
      ),
    )
    const code = result[0] ?? 'missing'
    let value: T | undefined
    if (result[1]) value = decodeScriptValue<T>(result[1])
    return { code, value }
  }

  #rootRunId(runId: string) {
    return this.#client.get(this.#keys.runRoot(runId))
  }

  async #requireRootRunId(runId: string, fence?: WriteFence) {
    const rootRunId = await this.#rootRunId(runId)
    if (rootRunId) return rootRunId
    await this.#assertFence(fence)
    throw new Error(`Missing workflow run [${runId}]`)
  }

  #resolveFence(
    fence: WriteFence | undefined,
    runId: string,
    rootRunId: string,
  ) {
    return resolveWriteFence(this.#client, this.#keys, fence, {
      runId,
      rootRunId,
    })
  }

  async #runFenced(
    name: ScriptName,
    fence: FenceCall,
    keys: readonly string[],
    arguments_: readonly string[],
  ) {
    const result = await this.#scripts.run(
      name,
      [...fence.keys, ...keys],
      [fence.argument, ...arguments_],
    )
    assertNotFenced(result)
    return result
  }

  /**
   * A fenced write that finds nothing to change still answers with the
   * fence's verdict, so a stale writer learns it lost its right either way.
   */
  async #assertFence(fence: WriteFence | undefined): Promise<undefined> {
    if (!fence?.runLease && !fence?.attempt) return undefined
    const call = await resolveWriteFence(this.#client, this.#keys, fence)
    assertNotFenced(
      await this.#scripts.run('checkFence', call.keys, [call.argument]),
    )
    return undefined
  }

  async #pruneTerminalRuns(params: PruneTerminalRunsParams) {
    const batchSize = normalizePruneBatchSize(params.batchSize)
    const statuses = normalizePruneStatuses(params.statuses)
    if (batchSize < 1 || statuses.length === 0) {
      await this.#delegates.pruneDeadCommands(params.olderThan)
      return { deleted: 0 }
    }
    const result = await this.#listRuns({
      status: statuses,
      parentRunId: null,
    })
    const roots: StoredRun[] = []
    for (const run of result.runs) {
      if (run.updatedAt < params.olderThan) roots.push(run)
    }
    roots.sort((left, right) => left.updatedAt - right.updatedAt)
    let deleted = 0
    for (const root of roots) {
      if (await this.#deleteFamily(root.id, params)) deleted += 1
      if (deleted >= batchSize) break
    }
    await this.#delegates.pruneDeadCommands(params.olderThan)
    return { deleted }
  }

  async #deleteRun(runId: string) {
    const family = await this.#loadFamilyByRun(runId)
    if (!family) return { deleted: false }
    const run = family.runs[runId]
    if (!run) return { deleted: false }
    if (run.parentRunId !== undefined) {
      throw new Error(`Run [${runId}] is not a root run`)
    }
    for (const id in family.runs) {
      const candidate = family.runs[id]
      if (!candidate || isTerminalRunStatus(candidate.status)) continue
      throw new Error(`Run [${runId}] has non-terminal runs`)
    }
    const deleted = await this.#deleteFamily(run.rootRunId)
    return { deleted }
  }

  async #deleteFamily(rootRunId: string, prune?: PruneTerminalRunsParams) {
    const family = await this.#loadFamily(rootRunId)
    if (!family) return false
    const runIds = new Set<string>()
    for (const id in family.runs) {
      const run = family.runs[id]
      if (!run) continue
      if (!isTerminalRunStatus(run.status)) {
        if (prune) return false
        throw new Error(`Run [${rootRunId}] has non-terminal runs`)
      }
      runIds.add(id)
    }
    const stateKeys = this.#keys.familyStateKeys(rootRunId)
    const args = prune
      ? [
          String(prune.olderThan),
          JSON.stringify(normalizePruneStatuses(prune.statuses)),
        ]
      : []
    const result = scriptResult(
      await this.#scripts.run(
        'deleteFamily',
        [
          this.#keys.family(rootRunId),
          this.#keys.familyRuns(rootRunId),
          this.#keys.activeRuns(),
          this.#keys.terminalRuns(),
          this.#keys.orderedRuns(),
          ...stateKeys,
        ],
        args,
      ),
    )
    if (result[0] === 'missing' || result[0] === 'skipped') return false
    if (result[0] === 'active') {
      if (prune) return false
      throw new Error(`Run [${rootRunId}] has non-terminal runs`)
    }
    // Remove the family first so a successful concurrent retry cannot lose
    // its new commands to cleanup based on an older terminal snapshot.
    await this.#delegates.deleteCommands(runIds)
    return true
  }
}

const runnableName = (input: CreateRunInput) =>
  input.name ?? input.taskName ?? input.workflowName

const runMatchesCreateInput = (run: StoredRun, input: CreateRunInput) =>
  run.kind === (input.kind ?? 'workflow') &&
  run.name === runnableName(input) &&
  run.workflowName === input.workflowName &&
  run.taskName === input.taskName &&
  run.parentRunId === input.parentRunId &&
  run.parentNodeName === input.parentNodeName &&
  run.rootRunId === (input.rootRunId ?? run.id) &&
  sameValue(run.input, input.input)

const compareRunsOldest = (left: StoredRun, right: StoredRun) =>
  left.createdAt - right.createdAt || left.id.localeCompare(right.id)

const compareAttempts = (left: StoredAttempt, right: StoredAttempt) =>
  left.dispatchedAt - right.dispatchedAt || left.id.localeCompare(right.id)

const compareChildrenForDetail = (
  left: StoredNodeChild,
  right: StoredNodeChild,
) =>
  left.nodeName.localeCompare(right.nodeName) ||
  left.ordinal - right.ordinal ||
  left.childKey.localeCompare(right.childKey)

const compareChildren = (left: StoredNodeChild, right: StoredNodeChild) =>
  left.ordinal - right.ordinal || left.childKey.localeCompare(right.childKey)

const runSummary = (family: Family, run: StoredRun): RunSummary => {
  const { input: _input, output: _output, ...summary } = run
  let nodesTotal = 0
  let nodesCompleted = 0
  for (const node of Object.values(family.nodes)) {
    if (node.runId !== run.id) continue
    nodesTotal += 1
    if (node.status === 'completed') nodesCompleted += 1
  }
  return {
    ...summary,
    nodesTotal,
    nodesCompleted,
  }
}

const nodeSummary = (node: StoredNode): NodeSummary => {
  const { input: _input, output: _output, ...summary } = node
  return summary
}

const childSummary = (child: StoredNodeChild): NodeChildSummary => {
  const { item: _item, input: _input, output: _output, ...summary } = child
  return summary
}

const attemptSummary = (attempt: StoredAttempt): AttemptSummary => {
  const { input: _input, output: _output, ...summary } = attempt
  return summary
}

const jsonContains = (target: unknown, expected: unknown): boolean => {
  if (expected === undefined) return true
  if (Array.isArray(expected)) {
    if (!Array.isArray(target)) return false
    for (const expectedItem of expected) {
      let found = false
      for (const item of target) {
        if (!jsonContains(item, expectedItem)) continue
        found = true
        break
      }
      if (!found) return false
    }
    return true
  }
  if (expected && typeof expected === 'object') {
    if (!target || typeof target !== 'object' || Array.isArray(target))
      return false
    const actual = target as Record<string, unknown>
    const fields = expected as Record<string, unknown>
    for (const key of Object.keys(fields)) {
      if (!jsonContains(actual[key], fields[key])) return false
    }
    return true
  }
  return Object.is(target, expected)
}

const runMatchesFilter = (run: StoredRun, filter: ListRunsFilter) => {
  if (
    filter.activeBefore !== undefined &&
    run.activeSince >= filter.activeBefore
  )
    return false
  if (filter.kind !== undefined && run.kind !== filter.kind) return false
  if (filter.name !== undefined && run.name !== filter.name) return false
  if (Array.isArray(filter.status)) {
    if (!filter.status.includes(run.status)) return false
  } else if (filter.status !== undefined && run.status !== filter.status) {
    return false
  }
  if (
    filter.createdBefore !== undefined &&
    run.createdAt >= filter.createdBefore
  )
    return false
  if (filter.parentRunId !== undefined) {
    if (filter.parentRunId === null) {
      if (run.parentRunId !== undefined) return false
    } else if (run.parentRunId !== filter.parentRunId) {
      return false
    }
  }
  if (filter.rootRunId !== undefined && run.rootRunId !== filter.rootRunId)
    return false
  if (filter.tags !== undefined) {
    for (const key in filter.tags) {
      if (run.tags[key] !== filter.tags[key]) return false
    }
  }
  return filter.input === undefined || jsonContains(run.input, filter.input)
}

const childRef = (runId: string, nodeName: string, childKey: string) =>
  `${runId}.${nodeName}.${childKey}`

const scriptResult = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error('Redis workflow script returned an invalid result')
  }
  const result: string[] = []
  for (const item of value) result.push(String(item ?? ''))
  return result
}

const decodeScriptValue = <T>(value: string | undefined): T => {
  if (value === undefined) {
    throw new Error('Redis workflow script omitted its result value')
  }
  return decode<T>(value)
}

export function decodeRecord<T>(values: Record<string, string>) {
  const decoded: Record<string, T> = Object.create(null)
  for (const key of Object.keys(values)) {
    const raw = values[key]
    if (raw !== undefined) decoded[key] = decode<T>(raw)
  }
  return decoded
}

export function decodeOrderedRecord<T>(
  values: Record<string, string>,
  orderedKeys: readonly string[],
) {
  const decoded: Record<string, T> = Object.create(null)
  for (const key of orderedKeys) {
    if (!Object.hasOwn(values, key)) continue
    const raw = values[key]
    if (raw !== undefined) decoded[key] = decode<T>(raw)
  }
  for (const key of Object.keys(values)) {
    if (Object.hasOwn(decoded, key)) continue
    const raw = values[key]
    if (raw !== undefined) decoded[key] = decode<T>(raw)
  }
  return decoded
}

const appendEncodedFields = (encoded: string | undefined, target: string[]) => {
  if (!encoded) return
  const fields = decode<string[]>(encoded)
  for (const field of fields) target.push(field)
}

const nodeChildrenMatch = (
  existing: readonly StoredNodeChild[],
  params: EnsureNodeChildrenParams,
) => {
  if (existing.length !== params.children.length) return false
  for (const input of params.children) {
    const matched = existing.find((child) => child.childKey === input.childKey)
    if (
      !matched ||
      matched.kind !== input.kind ||
      matched.ordinal !== (input.ordinal ?? 0) ||
      matched.itemKey !== input.itemKey ||
      !sameValue(matched.item, input.item)
    ) {
      return false
    }
  }
  return true
}

const normalizePruneBatchSize = (batchSize: number | undefined) => {
  if (batchSize === undefined) return DEFAULT_PRUNE_BATCH_SIZE
  if (Number.isInteger(batchSize) && batchSize > 0) return batchSize
  return 0
}

const normalizePruneStatuses = (
  statuses: PruneTerminalRunsParams['statuses'],
): readonly TerminalRunStatus[] => {
  const selected = new Set<TerminalRunStatus>()
  for (const status of statuses ?? DEFAULT_PRUNE_STATUSES) {
    if (DEFAULT_PRUNE_STATUSES.includes(status)) selected.add(status)
  }
  return Array.from(selected)
}
