import { randomUUID } from 'node:crypto'

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
  ListRunsFilter,
  NodeChildSummary,
  NodeSummary,
  PruneTerminalRunsParams,
  RunDetail,
  RunFamilyEntry,
  RunLease,
  RunSummary,
  TerminalRunStatus,
  WorkflowStore,
} from '../../runtime/store.ts'
import type { WorkflowRedisClient } from './client.ts'
import type { RedisWorkflowKeys } from './keys.ts'
import {
  WorkflowRunConflictError,
  toStoredError,
} from '../../runtime/errors.ts'
import { isTerminalRunStatus } from '../../runtime/status.ts'
import { validateFailedRunRetry } from '../../runtime/store.ts'
import {
  RUN_TRANSITIONS,
  transitionSources as runtimeTransitionSources,
} from '../../runtime/transitions.ts'
import {
  createRedisId,
  decodeRedisValue,
  encodeRedisValue,
  redisChildKey,
  redisNodeKey,
  redisRunSignature,
  sameRedisValue,
  type RedisWorkflowFamily,
} from './state.ts'
import { RedisWorkflowStoreScripts } from './store-scripts.ts'

const READ_BATCH_SIZE = 128
const DEFAULT_PRUNE_BATCH_SIZE = 100
const DEFAULT_PRUNE_STATUSES = [
  'completed',
  'cancelled',
  'failed',
] as const satisfies readonly TerminalRunStatus[]

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

export type RedisWorkflowStoreDelegates = {
  listDeadCommands(runId?: string): Promise<readonly DeadWorkflowCommand[]>
  listUnreapedDeadCommands: WorkflowStore['listUnreapedDeadCommands']
  markDeadCommandReaped(id: string): Promise<void>
  requeueDeadCommand(id: string): Promise<void>
  deleteCommands(runIds: ReadonlySet<string>): Promise<void>
  pruneDeadCommands(olderThan: Date): Promise<void>
}

export type RedisWorkflowStoreOptions = {
  readonly client: WorkflowRedisClient
  readonly keys: RedisWorkflowKeys
  readonly terminalRetentionMs: number
  readonly delegates: RedisWorkflowStoreDelegates
}

export class RedisWorkflowStoreRuntime {
  readonly store: WorkflowStore
  readonly #client: WorkflowRedisClient
  readonly #keys: RedisWorkflowKeys
  readonly #terminalRetentionMs: number
  readonly #delegates: RedisWorkflowStoreDelegates
  readonly #scripts: RedisWorkflowStoreScripts

  constructor(options: RedisWorkflowStoreOptions) {
    this.#client = options.client
    this.#keys = options.keys
    this.#terminalRetentionMs = options.terminalRetentionMs
    this.#delegates = options.delegates
    this.#scripts = new RedisWorkflowStoreScripts(options.client)
    this.store = this.#createStore()
  }

  async createRunWithState(
    input: CreateRunInput,
    startAt?: Date,
  ): Promise<{
    readonly run: StoredRun
    readonly created: boolean
    readonly startAt: Date | undefined
  }> {
    const normalizedInput = await this.#normalizeCreateInput(input)
    const run = this.#createRunRecord(normalizedInput)
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
    if (startAt !== undefined) encodedStartAt = String(startAt.getTime())
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
          encodeRedisValue(run),
          redisRunSignature(normalizedInput),
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
    let storedStartAt: Date | undefined
    if (result[3]) storedStartAt = new Date(Number(result[3]))
    if (result[0] === 'created') {
      return { run: stored, created: true, startAt: storedStartAt }
    }
    if (result[0] === 'idempotent') {
      if (runMatchesCreateInput(stored, normalizedInput)) {
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
    const nodes = decodeRecord<StoredNode>(expected[1]!)
    const children = decodeRecord<StoredNodeChild>(expected[2]!)
    const attempts = decodeRecord<StoredAttempt>(expected[3]!)
    const snapshots: RunSnapshot[] = []
    for (const run of Object.values(runs)) {
      snapshots.push({
        run,
        nodes: Object.values(nodes).filter((node) => node.runId === run.id),
        children: Object.values(children)
          .filter((child) => child.runId === run.id)
          .sort(compareChildrenForDetail),
        attempts: Object.values(attempts).filter(
          (attempt) => attempt.runId === run.id,
        ),
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
    const date = new Date()
    let attempt: StoredAttempt | undefined
    let command: unknown = {
      kind: 'continueRun',
      runId: root.id,
      workflowName: root.workflowName,
    }
    let wakeKind: 'continue' | 'task' = 'continue'
    if (root.kind === 'task') {
      const child = children[redisChildKey(root.id, '$task', '$self')]!
      const previous = Object.values(attempts).find(
        (entry) =>
          entry.runId === root.id &&
          entry.nodeName === child.nodeName &&
          entry.childKey === child.childKey &&
          entry.attemptNumber === child.attemptCount,
      )!
      attempt = {
        id: createRedisId(),
        runId: root.id,
        nodeName: '$task',
        childKey: '$self',
        status: 'started',
        leaseToken: createRedisId(),
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
        leaseToken: attempt.leaseToken,
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
          encodeRedisValue(attempt ?? null),
          encodeRedisValue({
            id: createRedisId(),
            payload: command,
            rootRunId,
            deliveryCount: 0,
            createdAt: date,
            createdAtScore: date.getTime(),
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

  async #normalizeCreateInput(input: CreateRunInput): Promise<CreateRunInput> {
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
    return decodeRedisValue<StoredRun>(raw)
  }

  #createRunRecord(input: CreateRunInput): StoredRun {
    const date = new Date()
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
        const result = await this.createRunWithState(input)
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
        this.#selectNodeCase(params.runId, params.nodeName, params.caseKey),
      ensureNodeChildren: (params) => this.#ensureNodeChildren(params),
      ensureChildRun: (params) => this.#ensureChildRun(params),
      ensureChildAttempt: (params) => this.#ensureChildAttempt(params),
      createAttempt: (input) => this.#createAttempt(input),
      completeCurrentAttempt: (params) => this.#completeCurrentAttempt(params),
      failCurrentAttempt: (params) =>
        this.#settleCurrentAttempt(params.attemptId, params.leaseToken, {
          status: 'failed',
          error: toStoredError(params.error),
        }),
      timeoutCurrentAttempt: (params) =>
        this.#settleCurrentAttempt(params.attemptId, params.leaseToken, {
          status: 'timedOut',
          error: toStoredError(params.error),
        }),
      completeNodeChild: (params) =>
        this.#updateChildRecord(
          params.runId,
          params.nodeName,
          params.childKey,
          { status: 'completed', output: params.output },
        ),
      failNodeChild: (params) =>
        this.#updateChildRecord(
          params.runId,
          params.nodeName,
          params.childKey,
          { status: 'failed', error: toStoredError(params.error) },
        ),
      loadNodeChildren: async (params) => {
        const family = await this.#loadFamilyByRun(params.runId)
        if (!family) return { children: [], attempts: [] }
        const children: StoredNodeChild[] = []
        for (const key in family.children) {
          const child = family.children[key]
          if (!child) continue
          if (
            child.runId === params.runId &&
            child.nodeName === params.nodeName
          ) {
            children.push(child)
          }
        }
        children.sort(compareChildren)
        const attempts: StoredAttempt[] = []
        for (const key in family.attempts) {
          const attempt = family.attempts[key]
          if (!attempt) continue
          if (
            attempt.runId === params.runId &&
            attempt.nodeName === params.nodeName
          ) {
            attempts.push(attempt)
          }
        }
        attempts.sort(compareAttempts)
        return {
          children,
          attempts,
        }
      },
      completeNode: (params) =>
        this.#updateNodeRecord(
          params.runId,
          params.nodeName,
          'nodeTransition',
          {
            status: 'completed',
            output: params.output,
          },
        ),
      failNode: (params) =>
        this.#updateNodeRecord(
          params.runId,
          params.nodeName,
          'nodeTransition',
          {
            status: 'failed',
            error: toStoredError(params.error),
          },
        ),
      waitNode: (params) =>
        this.#updateNodeRecord(params.runId, params.nodeName, 'nodeWait', {
          status: 'waiting',
        }),
      markRunRunning: ({ runId }) => this.#transitionRun(runId, 'running'),
      markRunWaiting: ({ runId }) => this.#transitionRun(runId, 'waiting'),
      completeRun: ({ runId, output }) =>
        this.#terminalRun(runId, { status: 'completed', output }),
      failRun: ({ runId, error }) =>
        this.#terminalRun(runId, {
          status: 'failed',
          error: toStoredError(error),
        }),
      requestRunCancellation: ({ runId }) => this.#requestCancellation(runId),
      cancelRun: ({ runId }) =>
        this.#terminalRun(runId, { status: 'cancelled' }),
      cancelNode: ({ runId, nodeName }) =>
        this.#updateNodeRecord(runId, nodeName, 'nodeTransition', {
          status: 'cancelled',
        }),
      cancelNonTerminalRunNodes: ({ runId }) =>
        this.#cancelNonTerminalRunNodes(runId),
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
        const run = decodeRedisValue<StoredRun>(raw)
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
    const [meta, runs, nodes, children, attempts, leases, orders, indexes] =
      await Promise.all([
        this.#client.hgetall(this.#keys.family(rootRunId)),
        this.#client.hgetall(this.#keys.familyRuns(rootRunId)),
        this.#client.hgetall(this.#keys.familyNodes(rootRunId)),
        this.#client.hgetall(this.#keys.familyChildren(rootRunId)),
        this.#client.hgetall(this.#keys.familyAttempts(rootRunId)),
        this.#client.hgetall(this.#keys.familyLeases(rootRunId)),
        this.#client.hgetall(this.#keys.familyOrders(rootRunId)),
        this.#client.hgetall(this.#keys.familyIndexes(rootRunId)),
      ])
    if (!meta.rootRunId) return undefined
    const runIds = decodeRedisValue<string[]>(meta.runIds ?? '[]')
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
      runLeases: decodeRecord<RedisWorkflowFamily['runLeases'][string]>(leases),
      runOrder: numberRecord(orders),
      externalKeys: decodeRedisValue<string[]>(meta.externalKeys ?? '[]'),
    } satisfies RedisWorkflowFamily
  }

  async #loadRunSnapshot(runId: string): Promise<RunSnapshot | undefined> {
    const family = await this.#loadFamilyByRun(runId)
    if (!family) return undefined
    const run = family.runs[runId]
    if (!run) return undefined
    const nodes: StoredNode[] = []
    for (const key in family.nodes) {
      const node = family.nodes[key]
      if (!node) continue
      if (node.runId === runId) nodes.push(node)
    }
    const children: StoredNodeChild[] = []
    for (const key in family.children) {
      const child = family.children[key]
      if (!child) continue
      if (child.runId === runId) children.push(child)
    }
    const attempts: StoredAttempt[] = []
    for (const key in family.attempts) {
      const attempt = family.attempts[key]
      if (!attempt) continue
      if (attempt.runId === runId) attempts.push(attempt)
    }
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
    for (const key in family.children) {
      const child = family.children[key]
      if (!child) continue
      if (child.runId !== runId) continue
      children.push(child)
      if (child.childRunId) childRunIds.add(child.childRunId)
    }
    children.sort(compareChildrenForDetail)
    const nodes: NodeSummary[] = []
    for (const key in family.nodes) {
      const node = family.nodes[key]
      if (!node) continue
      if (node.runId === runId) nodes.push(nodeSummary(node))
    }
    const childSummaries: NodeChildSummary[] = []
    childSummaries.length = children.length
    let childIndex = 0
    for (const child of children) {
      childSummaries[childIndex] = childSummary(child)
      childIndex += 1
    }
    const attempts: StoredAttempt[] = []
    for (const key in family.attempts) {
      const attempt = family.attempts[key]
      if (!attempt) continue
      if (attempt.runId === runId) attempts.push(attempt)
    }
    attempts.sort(compareAttempts)
    const attemptSummaries: AttemptSummary[] = []
    attemptSummaries.length = attempts.length
    let attemptIndex = 0
    for (const attempt of attempts) {
      attemptSummaries[attemptIndex] = attemptSummary(attempt)
      attemptIndex += 1
    }
    const childRuns: StoredRun[] = []
    for (const id in family.runs) {
      const candidate = family.runs[id]
      if (!candidate) continue
      if (childRunIds.has(candidate.id)) childRuns.push(candidate)
    }
    childRuns.sort(compareRunsOldest)
    const childRunSummaries: RunSummary[] = []
    childRunSummaries.length = childRuns.length
    let childRunIndex = 0
    for (const childRun of childRuns) {
      childRunSummaries[childRunIndex] = runSummary(family, childRun)
      childRunIndex += 1
    }
    return {
      run: runSummary(family, run),
      nodes,
      children: childSummaries,
      attempts: attemptSummaries,
      childRuns: childRunSummaries,
    }
  }

  async #loadNodeSnapshot(runId: string, nodeName: string) {
    const family = await this.#loadFamilyByRun(runId)
    if (!family) return undefined
    const node = family.nodes[redisNodeKey(runId, nodeName)]
    if (!node) return undefined
    const children: StoredNodeChild[] = []
    for (const key in family.children) {
      const child = family.children[key]
      if (!child) continue
      if (child.runId === runId && child.nodeName === nodeName) {
        children.push(child)
      }
    }
    children.sort(compareChildren)
    const attempts: StoredAttempt[] = []
    for (const key in family.attempts) {
      const attempt = family.attempts[key]
      if (!attempt) continue
      if (attempt.runId === runId && attempt.nodeName === nodeName) {
        attempts.push(attempt)
      }
    }
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
    for (const key in family.children) {
      const child = family.children[key]
      if (!child) continue
      if (child.childRunId && !origins.has(child.childRunId)) {
        origins.set(child.childRunId, {
          nodeName: child.nodeName,
          childKey: child.childKey,
        })
      }
    }
    const runs: StoredRun[] = []
    for (const id in family.runs) {
      const run = family.runs[id]
      if (run) runs.push(run)
    }
    runs.sort(compareRunsOldest)
    const entries: RunFamilyEntry[] = []
    entries.length = runs.length
    let index = 0
    for (const run of runs) {
      const origin = origins.get(run.id)
      const summary = runSummary(family, run)
      if (origin) entries[index] = { run: summary, origin }
      else entries[index] = { run: summary }
      index += 1
    }
    return entries
  }

  async #createNode(input: CreateNodeInput) {
    const rootRunId = await this.#requireRootRunId(input.runId)
    const date = new Date()
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
      await this.#scripts.run(
        'createNode',
        [
          this.#keys.familyNodes(rootRunId),
          this.#keys.familyIndexes(rootRunId),
          this.#keys.runWake(rootRunId),
          this.#keys.familyRuns(rootRunId),
        ],
        [
          redisNodeKey(input.runId, input.name),
          encodeRedisValue(node),
          input.runId,
        ],
      ),
    )
    if (result[0] === 'missing-run') {
      throw new Error(`Missing workflow run [${input.runId}]`)
    }
    return decodeScriptValue<StoredNode>(result[1])
  }

  async #updateNodeRecord(
    runId: string,
    nodeName: string,
    mode: string,
    changes: Partial<StoredNode>,
  ) {
    const rootRunId = await this.#rootRunId(runId)
    if (!rootRunId) return undefined
    const result = await this.#updateRecord<StoredNode>(
      this.#keys.familyNodes(rootRunId),
      this.#keys.runWake(rootRunId),
      redisNodeKey(runId, nodeName),
      mode,
      changes,
    )
    if (result.code === 'conflict') {
      throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
    }
    return result.value
  }

  async #setNodeInput(params: {
    readonly runId: string
    readonly nodeName: string
    readonly input: unknown
  }) {
    const node = await this.#updateNodeRecord(
      params.runId,
      params.nodeName,
      'nodeInput',
      { input: params.input },
    )
    if (node) return node
    throw new Error(`Missing node [${params.runId}.${params.nodeName}]`)
  }

  #selectNodeCase(runId: string, nodeName: string, caseKey: string) {
    return this.#updateNodeRecord(runId, nodeName, 'nodeCase', {
      selectedCase: caseKey,
    })
  }

  async #ensureNodeChildren(params: EnsureNodeChildrenParams) {
    const rootRunId = await this.#requireRootRunId(params.runId)
    const nodeField = redisNodeKey(params.runId, params.nodeName)
    const indexField = `children:${nodeField}`
    const date = new Date()
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
        field: redisChildKey(params.runId, params.nodeName, input.childKey),
        raw: encodeRedisValue(child),
      })
    }
    const result = scriptResult(
      await this.#scripts.run(
        'ensureChildren',
        [
          this.#keys.familyNodes(rootRunId),
          this.#keys.familyChildren(rootRunId),
          this.#keys.familyIndexes(rootRunId),
          this.#keys.runWake(rootRunId),
        ],
        [nodeField, indexField, encodeRedisValue(rows)],
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
        if (raw) existing.push(decodeRedisValue<StoredNodeChild>(raw))
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

  async #ensureChildRun(params: EnsureChildRunParams) {
    const rootRunId = await this.#requireRootRunId(params.runId)
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
    const childRun = this.#createRunRecord(input)
    let idempotencyKey = ''
    if (params.idempotencyKey) {
      idempotencyKey = this.#keys.idempotency(params.idempotencyKey)
    }
    const result = scriptResult(
      await this.#scripts.run(
        'createChildRun',
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
          redisChildKey(params.runId, params.nodeName, params.childKey),
          encodeRedisValue(childRun),
          redisRunSignature(input),
          this.#keys.runRoot(childRun.id),
          this.#keys.startDispatch(childRun.id),
          idempotencyKey,
          String(Date.now()),
          this.#keys.prefix,
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

  #ensureChildAttempt(params: EnsureChildAttemptParams) {
    return this.#createChildAttempt(params, true)
  }

  async #createAttempt(input: CreateAttemptInput) {
    const result = await this.#createChildAttempt(input, false)
    return result.attempt
  }

  async #createChildAttempt(
    input: CreateAttemptInput | EnsureChildAttemptParams,
    ensure: boolean,
  ) {
    const rootRunId = await this.#requireRootRunId(input.runId)
    const childField = redisChildKey(
      input.runId,
      input.nodeName,
      input.childKey,
    )
    const nodeField = redisNodeKey(input.runId, input.nodeName)
    const attempt: Mutable<StoredAttempt> = {
      id: createRedisId(),
      runId: input.runId,
      nodeName: input.nodeName,
      childKey: input.childKey,
      status: 'started',
      leaseToken: createRedisId(),
      attemptNumber: 0,
      retryAttemptNumber: 1,
      input: input.input,
      dispatchedAt: new Date(),
    }
    if (input.idempotencyKey !== undefined) {
      attempt.idempotencyKey = input.idempotencyKey
    }
    let ensureFlag = '0'
    if (ensure) ensureFlag = '1'
    const result = scriptResult(
      await this.#scripts.run(
        'createAttempt',
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
          encodeRedisValue(attempt),
          attempt.id,
          this.#keys.attemptRoot(attempt.id),
          rootRunId,
          `attempts:${nodeField}`,
          ensureFlag,
          String(Date.now()),
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

  #completeCurrentAttempt(params: {
    attemptId: string
    leaseToken: string
    output: unknown
  }) {
    return this.#settleAttempt(
      params.attemptId,
      params.leaseToken,
      {
        status: 'completed',
        output: params.output,
      },
      true,
    )
  }

  #settleCurrentAttempt(
    attemptId: string,
    leaseToken: string,
    settled: Pick<StoredAttempt, 'status'> & Partial<StoredAttempt>,
  ) {
    return this.#settleAttempt(attemptId, leaseToken, settled, false)
  }

  async #settleAttempt(
    attemptId: string,
    leaseToken: string,
    settled: Pick<StoredAttempt, 'status'> & Partial<StoredAttempt>,
    completeChild: boolean,
  ) {
    const rootRunId = await this.#client.get(this.#keys.attemptRoot(attemptId))
    if (!rootRunId) return undefined
    const raw = await this.#client.hget(
      this.#keys.familyAttempts(rootRunId),
      attemptId,
    )
    if (!raw) return undefined
    const attempt = decodeRedisValue<StoredAttempt>(raw)
    const childField = redisChildKey(
      attempt.runId,
      attempt.nodeName,
      attempt.childKey,
    )
    let completeChildFlag = '0'
    if (completeChild) completeChildFlag = '1'
    const result = scriptResult(
      await this.#scripts.run(
        'settleAttempt',
        [
          this.#keys.familyAttempts(rootRunId),
          this.#keys.familyChildren(rootRunId),
          this.#keys.runWake(rootRunId),
        ],
        [
          attemptId,
          leaseToken,
          childField,
          encodeRedisValue(settled),
          String(Date.now()),
          completeChildFlag,
        ],
      ),
    )
    if (result[0] === 'stale') return undefined
    return decodeScriptValue<StoredAttempt>(result[1])
  }

  async #updateChildRecord(
    runId: string,
    nodeName: string,
    childKey: string,
    changes: Partial<StoredNodeChild>,
  ) {
    const rootRunId = await this.#rootRunId(runId)
    if (!rootRunId) return undefined
    const result = await this.#updateRecord<StoredNodeChild>(
      this.#keys.familyChildren(rootRunId),
      this.#keys.runWake(rootRunId),
      redisChildKey(runId, nodeName, childKey),
      'childTransition',
      changes,
    )
    return result.value
  }

  async #transitionRun(runId: string, status: 'running' | 'waiting') {
    const rootRunId = await this.#rootRunId(runId)
    if (!rootRunId) return undefined
    const result = await this.#updateRecord<StoredRun>(
      this.#keys.familyRuns(rootRunId),
      this.#keys.runWake(rootRunId),
      runId,
      'runTransition',
      { status },
      transitionSources(status),
    )
    return result.value
  }

  async #terminalRun(
    runId: string,
    terminal: Pick<StoredRun, 'status'> & Partial<StoredRun>,
  ) {
    const run = await this.loadRun(runId)
    if (!run) return undefined
    let uniqueKey = ''
    if (run.unique?.scope === 'active') {
      uniqueKey = this.#keys.unique('active', run.unique.key)
    }
    const stateKeys = this.#keys.familyStateKeys(run.rootRunId)
    const result = scriptResult(
      await this.#scripts.run(
        'terminalRun',
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
          encodeRedisValue(terminal),
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

  async #requestCancellation(runId: string) {
    const rootRunId = await this.#rootRunId(runId)
    if (!rootRunId) return undefined
    const result = await this.#updateRecord<StoredRun>(
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

  async #cancelNonTerminalRunNodes(runId: string) {
    const rootRunId = await this.#requireRootRunId(runId)
    const result = await this.#scripts.run(
      'cancelNodes',
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
    return decodeRedisValue<StoredNode[]>(result)
  }

  async #acquireRunLease(params: { runId: string; leaseMs: number }) {
    const rootRunId = await this.#rootRunId(params.runId)
    if (!rootRunId) return undefined
    const lease = {
      runId: params.runId,
      leaseToken: createRedisId(),
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
        [
          'acquire',
          params.runId,
          '',
          String(params.leaseMs),
          encodeRedisValue(lease),
        ],
      ),
    )
    if (result[0] !== 'updated') return undefined
    return decodeScriptValue<RunLease & { expiresAt: Date }>(result[1])
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
    return decodeScriptValue<RunLease & { expiresAt: Date }>(result[1])
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
    hash: string,
    wake: string,
    field: string,
    mode: string,
    changes: Partial<T>,
    allowedSources: readonly string[] = [],
  ): Promise<{ code: string; value: T | undefined }> {
    const result = scriptResult(
      await this.#scripts.run(
        'updateRecord',
        [hash, wake],
        [
          field,
          mode,
          encodeRedisValue(changes),
          String(Date.now()),
          encodeRedisValue(allowedSources),
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

  async #requireRootRunId(runId: string) {
    const rootRunId = await this.#rootRunId(runId)
    if (!rootRunId) throw new Error(`Missing workflow run [${runId}]`)
    return rootRunId
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
    roots.sort(
      (left, right) => left.updatedAt.getTime() - right.updatedAt.getTime(),
    )
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
    return { deleted: await this.#deleteFamily(run.rootRunId) }
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
        prune
          ? [
              String(prune.olderThan.getTime()),
              JSON.stringify(normalizePruneStatuses(prune.statuses)),
            ]
          : [],
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
  sameRedisValue(run.input, input.input)

const compareRunsOldest = (left: StoredRun, right: StoredRun) =>
  left.createdAt.getTime() - right.createdAt.getTime() ||
  left.id.localeCompare(right.id)

const compareAttempts = (left: StoredAttempt, right: StoredAttempt) =>
  left.dispatchedAt.getTime() - right.dispatchedAt.getTime() ||
  left.id.localeCompare(right.id)

const compareChildrenForDetail = (
  left: StoredNodeChild,
  right: StoredNodeChild,
) =>
  left.nodeName.localeCompare(right.nodeName) ||
  left.ordinal - right.ordinal ||
  left.childKey.localeCompare(right.childKey)

const compareChildren = (left: StoredNodeChild, right: StoredNodeChild) =>
  left.ordinal - right.ordinal || left.childKey.localeCompare(right.childKey)

const runSummary = (
  family: RedisWorkflowFamily,
  run: StoredRun,
): RunSummary => {
  const { input: _input, output: _output, ...summary } = run
  let nodesTotal = 0
  let nodesCompleted = 0
  for (const key in family.nodes) {
    const node = family.nodes[key]
    if (!node) continue
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
      for (const targetItem of target) {
        if (!jsonContains(targetItem, expectedItem)) continue
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
    for (const key in expected) {
      if (!Object.hasOwn(expected, key)) continue
      if (
        !jsonContains(
          (target as Record<string, unknown>)[key],
          (expected as Record<string, unknown>)[key],
        )
      ) {
        return false
      }
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
  return decodeRedisValue<T>(value)
}

const decodeRecord = <T>(values: Record<string, string>) => {
  const decoded: Record<string, T> = {}
  for (const key in values) {
    const raw = values[key]
    if (raw !== undefined) decoded[key] = decodeRedisValue<T>(raw)
  }
  return decoded
}

const decodeOrderedRecord = <T>(
  values: Record<string, string>,
  orderedKeys: readonly string[],
) => {
  const decoded: Record<string, T> = {}
  for (const key of orderedKeys) {
    const raw = values[key]
    if (raw !== undefined) decoded[key] = decodeRedisValue<T>(raw)
  }
  for (const key in values) {
    if (Object.hasOwn(decoded, key)) continue
    const raw = values[key]
    if (raw !== undefined) decoded[key] = decodeRedisValue<T>(raw)
  }
  return decoded
}

const appendEncodedFields = (encoded: string | undefined, target: string[]) => {
  if (!encoded) return
  const fields = decodeRedisValue<string[]>(encoded)
  for (const field of fields) target.push(field)
}

const numberRecord = (values: Record<string, string>) => {
  const decoded: Record<string, number> = {}
  for (const key in values) {
    const raw = values[key]
    if (raw !== undefined) decoded[key] = Number(raw)
  }
  return decoded
}

const nodeChildrenMatch = (
  existing: readonly StoredNodeChild[],
  params: EnsureNodeChildrenParams,
) => {
  if (existing.length !== params.children.length) return false
  for (const input of params.children) {
    let matched: StoredNodeChild | undefined
    for (const child of existing) {
      if (child.childKey !== input.childKey) continue
      matched = child
      break
    }
    if (
      !matched ||
      matched.kind !== input.kind ||
      matched.ordinal !== (input.ordinal ?? 0) ||
      matched.itemKey !== input.itemKey ||
      !sameRedisValue(matched.item, input.item)
    ) {
      return false
    }
  }
  return true
}

const transitionSources = (status: 'running' | 'waiting') =>
  runtimeTransitionSources(RUN_TRANSITIONS, status)

const normalizePruneBatchSize = (batchSize: number | undefined) => {
  if (batchSize === undefined) return DEFAULT_PRUNE_BATCH_SIZE
  if (Number.isInteger(batchSize) && batchSize > 0) return batchSize
  return 0
}

const normalizePruneStatuses = (
  statuses: PruneTerminalRunsParams['statuses'],
): readonly TerminalRunStatus[] => {
  const normalized: TerminalRunStatus[] = []
  for (const status of statuses ?? DEFAULT_PRUNE_STATUSES) {
    if (!DEFAULT_PRUNE_STATUSES.includes(status)) continue
    let duplicate = false
    for (const existing of normalized) {
      if (existing !== status) continue
      duplicate = true
      break
    }
    if (!duplicate) normalized.push(status)
  }
  return normalized
}
