import type {
  ActivityAttemptCommand,
  AttemptCommand,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  TaskAttemptCommand,
} from './commands.ts'
import type { WorkflowRuntimeAtomicStart } from './coordinator.ts'
import type {
  AttemptExecutor,
  CommandReleaseOptions,
  RunCoordinationExecutor,
} from './executors.ts'
import type { StoredWorkflowSchedule, WorkflowScheduler } from './scheduler.ts'
import type {
  RunSnapshot,
  StoredAttempt,
  StoredError,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from './state.ts'
import type {
  CreateAttemptInput,
  CreateNodeInput,
  CreateRunInput,
  DeadWorkflowCommand,
  ListRunsFilter,
  PruneTerminalRunsParams,
  RunLease,
  TerminalRunStatus,
  WorkflowRetentionPruner,
  WorkflowStore,
} from './store.ts'
import { dispatchTaskRunAttempt } from './coordinator/attempt.ts'
import { toStoredError } from './errors.ts'
import {
  nextStoredScheduleRunAt,
  normalizeScheduleDefinitions,
  startStoredScheduleRun,
} from './scheduler.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from './status.ts'
import {
  NODE_TRANSITIONS,
  RUN_TRANSITIONS,
  canTransition,
} from './transitions.ts'

type InMemoryRunLease = RunLease & {
  readonly expiresAt: Date
}

type QueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly runAt?: Date
  readonly deliveryCount: number
  readonly lastError?: StoredError
  readonly deadAt?: Date
  readonly reapedAt?: Date
  readonly createdAt: Date
}

type InspectQueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly runAt?: Date
}

type ClaimedQueueItem<T> = QueueItem<T> & {
  readonly leaseToken: string
}

const RELEASE_BACKOFF_MS = 50
const UNROUTABLE_BACKOFF_MS = 1_000
const MAX_ERROR_BACKOFF_MS = 300_000
const DEFAULT_MAX_DELIVERIES = 20
const DEFAULT_PRUNE_BATCH_SIZE = 100
const DEFAULT_PRUNE_STATUSES = [
  'completed',
  'cancelled',
  'failed',
] as const satisfies readonly TerminalRunStatus[]

export type InMemoryWorkflowRuntime = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly retentionPruner: WorkflowRetentionPruner
  readonly scheduler: WorkflowScheduler
  readonly atomicStart: WorkflowRuntimeAtomicStart
  readonly inspect: () => {
    readonly runs: readonly StoredRun[]
    readonly nodes: readonly StoredNode[]
    readonly children: readonly StoredNodeChild[]
    readonly attempts: readonly StoredAttempt[]
    readonly continueRunCommands: readonly InspectQueueItem<ContinueRunCommand>[]
    readonly activityCommands: readonly InspectQueueItem<ActivityAttemptCommand>[]
    readonly taskCommands: readonly InspectQueueItem<TaskAttemptCommand>[]
    readonly schedules: readonly StoredWorkflowSchedule[]
  }
}

export function createInMemoryWorkflowRuntime(
  options: {
    readonly maxDeliveries?: number
  } = {},
): InMemoryWorkflowRuntime {
  let nextId = 1
  const id = (prefix: string) => `${prefix}-${nextId++}`
  let lastTimestamp = 0
  const now = () => {
    const current = Date.now()
    lastTimestamp = Math.max(current, lastTimestamp + 1)
    return new Date(lastTimestamp)
  }
  const maxDeliveries = options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES

  const runs = new Map<string, StoredRun>()
  const nodes = new Map<string, StoredNode>()
  const attempts = new Map<string, StoredAttempt>()
  const children = new Map<string, StoredNodeChild>()
  const runIdempotencyKeys = new Map<string, string>()
  const runLeases = new Map<string, InMemoryRunLease>()
  const continueRunCommands: QueueItem<ContinueRunCommand>[] = []
  const activityCommands: QueueItem<ActivityAttemptCommand>[] = []
  const taskCommands: QueueItem<TaskAttemptCommand>[] = []
  const claimedContinueRunCommands = new Map<
    string,
    ClaimedQueueItem<ContinueRunCommand>
  >()
  const claimedActivityCommands = new Map<
    string,
    ClaimedQueueItem<ActivityAttemptCommand>
  >()
  const claimedTaskCommands = new Map<
    string,
    ClaimedQueueItem<TaskAttemptCommand>
  >()
  const schedules = new Map<string, StoredWorkflowSchedule>()

  const nodeKey = (runId: string, nodeName: string) => `${runId}:${nodeName}`
  const childKey = (runId: string, nodeName: string, key: string) =>
    `${runId}:${nodeName}:${key}`
  const childRef = (runId: string, nodeName: string, key: string) =>
    `${runId}.${nodeName}.${key}`
  const sortedChildren = (rows: readonly StoredNodeChild[]) =>
    [...rows].sort((left, right) => {
      const byOrdinal = left.ordinal - right.ordinal
      if (byOrdinal !== 0) return byOrdinal
      return left.childKey.localeCompare(right.childKey)
    })
  const nodeChildren = (runId: string, nodeName: string) =>
    [...children.values()].filter(
      (child) => child.runId === runId && child.nodeName === nodeName,
    )
  const stableJsonValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableJsonValue)
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, stableJsonValue(item)]),
      )
    }
    return value
  }
  const valueKey = (value: unknown) => JSON.stringify(stableJsonValue(value))
  const sameValue = (left: unknown, right: unknown) =>
    valueKey(left) === valueKey(right)
  const sameOptionalValue = (left: unknown, right: unknown) =>
    left === undefined && right === undefined
      ? true
      : left !== undefined && right !== undefined && sameValue(left, right)
  const jsonContains = (target: unknown, expected: unknown): boolean => {
    if (expected === undefined) return true
    if (Array.isArray(expected)) {
      if (!Array.isArray(target)) return false
      return expected.every((expectedItem) =>
        target.some((targetItem) => jsonContains(targetItem, expectedItem)),
      )
    }
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if (!target || typeof target !== 'object' || Array.isArray(target)) {
        return false
      }

      const targetRecord = target as Record<string, unknown>
      return Object.entries(expected).every(([key, value]) =>
        jsonContains(targetRecord[key], value),
      )
    }

    return Object.is(target, expected)
  }

  const runMatchesFilter = (run: StoredRun, filter: ListRunsFilter) => {
    const statuses = Array.isArray(filter.status)
      ? filter.status
      : filter.status === undefined
        ? undefined
        : [filter.status]

    return (
      (filter.kind === undefined || run.kind === filter.kind) &&
      (filter.name === undefined || run.name === filter.name) &&
      (statuses === undefined || statuses.includes(run.status)) &&
      (filter.createdBefore === undefined ||
        run.createdAt < filter.createdBefore) &&
      (filter.parentRunId === undefined ||
        run.parentRunId === filter.parentRunId) &&
      (filter.rootRunId === undefined || run.rootRunId === filter.rootRunId) &&
      (filter.tags === undefined ||
        Object.entries(filter.tags).every(
          ([key, value]) => run.tags[key] === value,
        )) &&
      (filter.input === undefined || jsonContains(run.input, filter.input))
    )
  }

  const runIdempotencyKey = (key: readonly unknown[]) => valueKey(key)
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

  const createRunWithState = (
    input: CreateRunInput,
  ): { readonly run: StoredRun; readonly created: boolean } => {
    if (input.idempotencyKey) {
      const existingRunId = runIdempotencyKeys.get(
        runIdempotencyKey(input.idempotencyKey),
      )
      if (existingRunId) {
        const existing = runs.get(existingRunId)
        if (existing && runMatchesCreateInput(existing, input)) {
          return { run: existing, created: false }
        }

        throw new Error(`Conflicting idempotent run [${input.workflowName}]`)
      }
    }

    const date = now()
    const runId = id('run')
    const run: StoredRun = {
      id: runId,
      kind: input.kind ?? 'workflow',
      name: input.name ?? input.taskName ?? input.workflowName,
      workflowName: input.workflowName,
      ...(input.taskName === undefined ? {} : { taskName: input.taskName }),
      status: 'queued',
      input: input.input,
      ...(input.parentRunId === undefined
        ? {}
        : { parentRunId: input.parentRunId }),
      ...(input.parentNodeName === undefined
        ? {}
        : { parentNodeName: input.parentNodeName }),
      rootRunId: input.rootRunId ?? runId,
      tags: input.tags ?? {},
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: input.idempotencyKey }),
      version: 1,
      createdAt: date,
      updatedAt: date,
    }
    runs.set(run.id, run)
    if (input.idempotencyKey) {
      runIdempotencyKeys.set(runIdempotencyKey(input.idempotencyKey), run.id)
    }
    return { run, created: true }
  }

  const store: WorkflowStore = {
    async createRun(input: CreateRunInput) {
      return createRunWithState(input).run
    },
    async listRuns(filter: ListRunsFilter = {}) {
      const limit = filter.limit ?? Number.POSITIVE_INFINITY
      const offset = filter.cursor ? Number.parseInt(filter.cursor, 10) : 0
      if (
        filter.limit !== undefined &&
        (!Number.isFinite(limit) || limit < 1)
      ) {
        return { runs: [] }
      }
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`Invalid run list cursor [${filter.cursor}]`)
      }

      const filtered = [...runs.values()]
        .filter((run) => runMatchesFilter(run, filter))
        .sort((left, right) => {
          const byCreatedAt =
            right.createdAt.getTime() - left.createdAt.getTime()
          if (byCreatedAt !== 0) return byCreatedAt
          return right.id.localeCompare(left.id)
        })

      const page = filtered.slice(offset, offset + limit)
      const nextOffset = offset + page.length
      return {
        runs: page,
        ...(nextOffset < filtered.length
          ? { nextCursor: String(nextOffset) }
          : {}),
      }
    },
    async pruneTerminalRuns(params: PruneTerminalRunsParams) {
      const batchSize = normalizePruneBatchSize(params.batchSize)
      const statuses = normalizePruneStatuses(params.statuses)
      const deadBefore = params.olderThan.getTime()
      if (batchSize < 1 || statuses.length === 0) {
        sweepDeadCommands(deadBefore)
        return { deleted: 0 }
      }

      const roots = [...runs.values()]
        .filter(
          (run) =>
            run.parentRunId === undefined &&
            statuses.includes(run.status as TerminalRunStatus) &&
            run.updatedAt < params.olderThan,
        )
        .sort((left, right) => {
          const byUpdatedAt =
            left.updatedAt.getTime() - right.updatedAt.getTime()
          if (byUpdatedAt !== 0) return byUpdatedAt
          return left.id.localeCompare(right.id)
        })
        .slice(0, batchSize)
      const treeIds = collectRunTreeIds(roots.map((run) => run.id))
      deleteRunTrees(treeIds)
      sweepDeadCommands(deadBefore)
      return { deleted: roots.length }
    },
    async listDeadCommands() {
      return [
        ...continueRunCommands.flatMap((item) => {
          const dead = mapDeadCommand(item, 'continue')
          return dead === undefined ? [] : [dead]
        }),
        ...activityCommands.flatMap((item) => {
          const dead = mapDeadCommand(item, 'activity')
          return dead === undefined ? [] : [dead]
        }),
        ...taskCommands.flatMap((item) => {
          const dead = mapDeadCommand(item, 'task')
          return dead === undefined ? [] : [dead]
        }),
      ].sort((left, right) => {
        const byDeadAt = right.deadAt.getTime() - left.deadAt.getTime()
        if (byDeadAt !== 0) return byDeadAt
        return right.createdAt.getTime() - left.createdAt.getTime()
      })
    },
    async listUnreapedDeadCommands(params) {
      const limit = params?.limit ?? Number.POSITIVE_INFINITY
      const dead: DeadWorkflowCommand[] = []
      const collect = <T>(
        queue: QueueItem<T>[],
        kind: DeadWorkflowCommand['kind'],
      ) => {
        for (const item of queue) {
          if (item.deadAt === undefined || item.reapedAt !== undefined) {
            continue
          }
          const command = mapDeadCommand(
            item as unknown as QueueItem<
              ContinueRunCommand | ActivityAttemptCommand | TaskAttemptCommand
            >,
            kind,
          )
          if (command !== undefined) dead.push(command)
        }
      }
      collect(continueRunCommands, 'continue')
      collect(activityCommands, 'activity')
      collect(taskCommands, 'task')
      return dead
        .sort((left, right) => left.deadAt.getTime() - right.deadAt.getTime())
        .slice(0, limit === Number.POSITIVE_INFINITY ? undefined : limit)
    },
    async markDeadCommandReaped(commandId) {
      const mark = <T>(queue: QueueItem<T>[]) => {
        const index = queue.findIndex(
          (item) =>
            item.id === commandId &&
            item.deadAt !== undefined &&
            item.reapedAt === undefined,
        )
        if (index === -1) return false
        queue[index] = { ...queue[index]!, reapedAt: now() }
        return true
      }
      if (mark(continueRunCommands)) return
      if (mark(activityCommands)) return
      mark(taskCommands)
    },
    async requeueDeadCommand(commandId) {
      if (requeueDead(continueRunCommands, commandId)) return
      if (requeueDead(activityCommands, commandId)) return
      requeueDead(taskCommands, commandId)
    },
    async acquireRunLease({ runId, leaseMs }) {
      const date = now()
      const existingLease = runLeases.get(runId)
      if (existingLease && existingLease.expiresAt > date) return undefined

      const run = runs.get(runId)
      if (!run) return undefined

      const lease = {
        runId,
        leaseToken: id('run-lease'),
        version: run.version,
        expiresAt: new Date(date.getTime() + leaseMs),
      }
      runLeases.set(runId, lease)
      return lease
    },
    async renewRunLease(lease, leaseMs) {
      const existingLease = runLeases.get(lease.runId)
      if (existingLease?.leaseToken !== lease.leaseToken) return undefined
      const renewedLease = {
        ...existingLease,
        expiresAt: new Date(now().getTime() + leaseMs),
      }
      runLeases.set(lease.runId, renewedLease)
      return renewedLease
    },
    async releaseRunLease(lease) {
      if (runLeases.get(lease.runId)?.leaseToken === lease.leaseToken) {
        runLeases.delete(lease.runId)
      }
    },
    async loadRuns(runIds) {
      return [...new Set(runIds)].flatMap((runId) => {
        const run = runs.get(runId)
        return run ? [run] : []
      })
    },
    async loadRunSnapshot(runId) {
      const run = runs.get(runId)
      if (!run) return undefined

      const snapshot: RunSnapshot = {
        run,
        nodes: [...nodes.values()].filter((node) => node.runId === runId),
        children: [...children.values()].filter(
          (child) => child.runId === runId,
        ),
        attempts: [...attempts.values()].filter(
          (attempt) => attempt.runId === runId,
        ),
      }
      return snapshot
    },
    async createNode(input: CreateNodeInput) {
      const key = nodeKey(input.runId, input.name)
      const existing = nodes.get(key)
      if (existing) return existing

      const date = now()
      const node: StoredNode = {
        runId: input.runId,
        name: input.name,
        kind: input.kind,
        status: 'pending',
        version: 1,
        createdAt: date,
        updatedAt: date,
      }
      nodes.set(key, node)
      return node
    },
    async setNodeInput({ runId, nodeName, input }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) throw new Error(`Missing node [${runId}.${nodeName}]`)
      if (isTerminalNodeStatus(node.status)) return node

      const updated: StoredNode = {
        ...node,
        input,
        status: 'running',
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },
    async selectNodeCase({ runId, nodeName, caseKey }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node
      if (node.selectedCase === caseKey) return node
      if (node.selectedCase !== undefined) {
        throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
      }

      const updated: StoredNode = {
        ...node,
        selectedCase: caseKey,
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },
    async createAttempt(input: CreateAttemptInput) {
      const child = children.get(
        childKey(input.runId, input.nodeName, input.childKey),
      )
      if (!child) {
        throw new Error(
          `Missing node child [${childRef(input.runId, input.nodeName, input.childKey)}]`,
        )
      }
      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${childRef(input.runId, input.nodeName, input.childKey)}] cannot create attempt`,
        )
      }

      return createChildAttempt(child, input.input, input.idempotencyKey)
    },
    async completeCurrentAttempt({ attemptId, leaseToken, output }) {
      const fenced = fencedCurrentAttempt(attemptId, leaseToken)
      if (!fenced) return undefined

      const { attempt, child } = fenced
      const updated: StoredAttempt = {
        ...attempt,
        status: 'completed',
        output,
        completedAt: now(),
      }
      attempts.set(attemptId, updated)
      const completedChild: StoredNodeChild = {
        ...child,
        status: 'completed',
        output,
        version: child.version + 1,
        updatedAt: now(),
      }
      children.set(
        childKey(child.runId, child.nodeName, child.childKey),
        completedChild,
      )
      return updated
    },
    async failCurrentAttempt({ attemptId, leaseToken, error }) {
      const fenced = fencedCurrentAttempt(attemptId, leaseToken)
      if (!fenced) return undefined

      const updated: StoredAttempt = {
        ...fenced.attempt,
        status: 'failed',
        error: toStoredError(error),
        completedAt: now(),
      }
      attempts.set(attemptId, updated)
      return updated
    },
    async timeoutCurrentAttempt({ attemptId, leaseToken, error }) {
      const fenced = fencedCurrentAttempt(attemptId, leaseToken)
      if (!fenced) return undefined

      const updated: StoredAttempt = {
        ...fenced.attempt,
        status: 'timedOut',
        error: toStoredError(error),
        completedAt: now(),
      }
      attempts.set(attemptId, updated)
      return updated
    },
    async completeNode({ runId, nodeName, output }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node

      const updated: StoredNode = {
        ...node,
        status: 'completed',
        output,
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },
    async failNode({ runId, nodeName, error }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node

      const updated: StoredNode = {
        ...node,
        status: 'failed',
        error: toStoredError(error),
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },
    async markRunRunning({ runId }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (!canTransition(RUN_TRANSITIONS, run.status, 'running')) return run

      const updated: StoredRun = {
        ...run,
        status: 'running',
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      return updated
    },
    async markRunWaiting({ runId }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (!canTransition(RUN_TRANSITIONS, run.status, 'waiting')) return run

      const updated: StoredRun = {
        ...run,
        status: 'waiting',
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      return updated
    },
    async completeRun({ runId, output }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (isTerminalRunStatus(run.status)) return run

      const updated: StoredRun = {
        ...run,
        status: 'completed',
        output,
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      return updated
    },
    async failRun({ runId, error }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (isTerminalRunStatus(run.status)) return run

      const updated: StoredRun = {
        ...run,
        status: 'failed',
        error: toStoredError(error),
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      return updated
    },
    async requestRunCancellation({ runId }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (isTerminalRunStatus(run.status) || run.status === 'cancelling') {
        return run
      }

      const updated: StoredRun = {
        ...run,
        status: 'cancelling',
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      return updated
    },
    async cancelRun({ runId }) {
      const run = runs.get(runId)
      if (!run) return undefined
      if (isTerminalRunStatus(run.status)) return run

      const updated: StoredRun = {
        ...run,
        status: 'cancelled',
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      return updated
    },
    async cancelNode({ runId, nodeName }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node

      const updated: StoredNode = {
        ...node,
        status: 'cancelled',
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },
    async cancelNonTerminalRunNodes({ runId }) {
      const updated: StoredNode[] = []
      for (const node of Array.from(nodes.values())) {
        if (node.runId !== runId || isTerminalNodeStatus(node.status)) continue
        const cancelled: StoredNode = {
          ...node,
          status: 'cancelled',
          version: node.version + 1,
          updatedAt: now(),
        }
        nodes.set(nodeKey(node.runId, node.name), cancelled)
        updated.push(cancelled)
      }
      for (const child of Array.from(children.values())) {
        if (child.runId !== runId || isTerminalNodeStatus(child.status)) {
          continue
        }
        children.set(childKey(child.runId, child.nodeName, child.childKey), {
          ...child,
          status: 'cancelled',
          version: child.version + 1,
          updatedAt: now(),
        })
      }
      return updated
    },
    async ensureNodeChildren(params) {
      const node = nodes.get(nodeKey(params.runId, params.nodeName))
      if (!node) {
        throw new Error(`Missing node [${params.runId}.${params.nodeName}]`)
      }

      const existing = nodeChildren(params.runId, params.nodeName)
      if (existing.length > 0) {
        const matches =
          existing.length === params.children.length &&
          params.children.every((input) => {
            const child = children.get(
              childKey(params.runId, params.nodeName, input.childKey),
            )
            return (
              child !== undefined &&
              child.kind === input.kind &&
              child.ordinal === (input.ordinal ?? 0) &&
              child.itemKey === input.itemKey &&
              sameOptionalValue(child.item, input.item)
            )
          })
        if (!matches) {
          throw new Error(
            `Conflicting node children [${params.runId}.${params.nodeName}]`,
          )
        }
        return { children: sortedChildren(existing), created: false }
      }

      const date = now()
      const created = params.children.map((input): StoredNodeChild => {
        const child: StoredNodeChild = {
          runId: params.runId,
          nodeName: params.nodeName,
          childKey: input.childKey,
          kind: input.kind,
          status: 'pending',
          ordinal: input.ordinal ?? 0,
          ...(input.itemKey === undefined ? {} : { itemKey: input.itemKey }),
          ...(input.item === undefined ? {} : { item: input.item }),
          attemptCount: 0,
          version: 1,
          createdAt: date,
          updatedAt: date,
        }
        children.set(
          childKey(params.runId, params.nodeName, input.childKey),
          child,
        )
        return child
      })
      return { children: sortedChildren(created), created: true }
    },
    async ensureChildRun(params) {
      const key = childKey(params.runId, params.nodeName, params.childKey)
      const child = children.get(key)
      if (!child) {
        throw new Error(
          `Missing node child [${childRef(params.runId, params.nodeName, params.childKey)}]`,
        )
      }

      if (child.childRunId !== undefined) {
        const childRun = runs.get(child.childRunId)
        if (!childRun) {
          throw new Error(`Missing child run [${child.childRunId}]`)
        }
        if (
          childRun.kind !== params.childKind ||
          childRun.name !== params.childName ||
          !sameValue(childRun.input, params.input) ||
          !sameOptionalValue(childRun.idempotencyKey, params.idempotencyKey)
        ) {
          throw new Error(
            `Conflicting child run [${childRef(params.runId, params.nodeName, params.childKey)}]`,
          )
        }
        return { child, childRun, created: false }
      }

      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${childRef(params.runId, params.nodeName, params.childKey)}] cannot start child run`,
        )
      }

      const childRun = createRunWithState({
        kind: params.childKind,
        name: params.childName,
        workflowName: params.childName,
        ...(params.childKind === 'task' ? { taskName: params.childName } : {}),
        input: params.input,
        parentRunId: params.runId,
        parentNodeName: params.nodeName,
        rootRunId: params.rootRunId,
        ...(params.tags === undefined ? {} : { tags: params.tags }),
        ...(params.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: params.idempotencyKey }),
      }).run
      const linked: StoredNodeChild = {
        ...child,
        childRunId: childRun.id,
        status: 'running',
        version: child.version + 1,
        updatedAt: now(),
      }
      children.set(key, linked)
      return { child: linked, childRun, created: true }
    },
    async ensureChildAttempt(params) {
      const child = children.get(
        childKey(params.runId, params.nodeName, params.childKey),
      )
      if (!child) {
        throw new Error(
          `Missing node child [${childRef(params.runId, params.nodeName, params.childKey)}]`,
        )
      }

      if (child.attemptCount > 0) {
        const current =
          (child.currentAttemptId !== undefined
            ? attempts.get(child.currentAttemptId)
            : undefined) ??
          [...attempts.values()]
            .filter(
              (attempt) =>
                attempt.runId === child.runId &&
                attempt.nodeName === child.nodeName &&
                attempt.childKey === child.childKey,
            )
            .sort((left, right) => right.attemptNumber - left.attemptNumber)[0]
        if (!current) {
          throw new Error(
            `Missing node child attempt [${childRef(params.runId, params.nodeName, params.childKey)}]`,
          )
        }
        return { attempt: current, created: false }
      }
      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${childRef(params.runId, params.nodeName, params.childKey)}] cannot create attempt`,
        )
      }

      const attempt = createChildAttempt(
        child,
        params.input,
        params.idempotencyKey,
      )
      return { attempt, created: true }
    },
    async completeNodeChild({ runId, nodeName, childKey: key, output }) {
      const mapKey = childKey(runId, nodeName, key)
      const child = children.get(mapKey)
      if (!child) return undefined
      if (isTerminalNodeStatus(child.status)) return child

      const updated: StoredNodeChild = {
        ...child,
        status: 'completed',
        output,
        version: child.version + 1,
        updatedAt: now(),
      }
      children.set(mapKey, updated)
      return updated
    },
    async failNodeChild({ runId, nodeName, childKey: key, error }) {
      const mapKey = childKey(runId, nodeName, key)
      const child = children.get(mapKey)
      if (!child) return undefined
      if (isTerminalNodeStatus(child.status)) return child

      const updated: StoredNodeChild = {
        ...child,
        status: 'failed',
        error: toStoredError(error),
        version: child.version + 1,
        updatedAt: now(),
      }
      children.set(mapKey, updated)
      return updated
    },
    async waitNode({ runId, nodeName }) {
      const key = nodeKey(runId, nodeName)
      const node = nodes.get(key)
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node
      if (node.status === 'waiting') return node

      const updated: StoredNode = {
        ...node,
        status: 'waiting',
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
      return updated
    },
    async loadNodeChildren({ runId, nodeName }) {
      return {
        children: sortedChildren(nodeChildren(runId, nodeName)),
        attempts: [...attempts.values()].filter(
          (attempt) => attempt.runId === runId && attempt.nodeName === nodeName,
        ),
      }
    },
  }

  const createChildAttempt = (
    child: StoredNodeChild,
    input: unknown,
    idempotencyKey: readonly unknown[] | undefined,
  ): StoredAttempt => {
    const attempt: StoredAttempt = {
      id: id('attempt'),
      runId: child.runId,
      nodeName: child.nodeName,
      childKey: child.childKey,
      status: 'started',
      leaseToken: id('attempt-lease'),
      attemptNumber: child.attemptCount + 1,
      input,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      dispatchedAt: now(),
    }
    attempts.set(attempt.id, attempt)
    children.set(childKey(child.runId, child.nodeName, child.childKey), {
      ...child,
      status: 'running',
      currentAttemptId: attempt.id,
      attemptCount: child.attemptCount + 1,
      version: child.version + 1,
      updatedAt: now(),
    })

    // Aggregate hint only: the node mirrors "some child is executing" so
    // observers see progress without deriving it from child rows.
    const key = nodeKey(child.runId, child.nodeName)
    const node = nodes.get(key)
    // Self-inclusive like the postgres guard, so version bumps stay in
    // lockstep across adapters even when the node is already running.
    if (
      node &&
      (node.status === 'running' ||
        canTransition(NODE_TRANSITIONS, node.status, 'running'))
    ) {
      nodes.set(key, {
        ...node,
        status: 'running',
        version: node.version + 1,
        updatedAt: now(),
      })
    }
    return attempt
  }

  const fencedCurrentAttempt = (
    attemptId: string,
    leaseToken: string,
  ):
    | { readonly attempt: StoredAttempt; readonly child: StoredNodeChild }
    | undefined => {
    const attempt = attempts.get(attemptId)
    if (!attempt || attempt.leaseToken !== leaseToken) return undefined
    if (attempt.status !== 'started') return undefined

    const child = children.get(
      childKey(attempt.runId, attempt.nodeName, attempt.childKey),
    )
    if (
      !child ||
      isTerminalNodeStatus(child.status) ||
      child.currentAttemptId !== attemptId
    ) {
      return undefined
    }
    return { attempt, child }
  }

  const normalizePruneBatchSize = (batchSize: number | undefined) => {
    if (batchSize === undefined) return DEFAULT_PRUNE_BATCH_SIZE
    if (!Number.isInteger(batchSize) || batchSize < 1) return 0
    return batchSize
  }
  const normalizeScheduleLimit = (limit: number | undefined) => {
    if (limit === undefined) return 100
    if (!Number.isInteger(limit) || limit < 1) return 0
    return limit
  }
  const normalizePruneStatuses = (
    statuses: PruneTerminalRunsParams['statuses'],
  ): readonly TerminalRunStatus[] => [
    ...new Set(
      (statuses ?? DEFAULT_PRUNE_STATUSES).filter((status) =>
        DEFAULT_PRUNE_STATUSES.includes(status),
      ),
    ),
  ]
  const collectRunTreeIds = (rootIds: readonly string[]) => {
    const treeIds = new Set(rootIds)
    let checkedSize = -1
    while (checkedSize !== treeIds.size) {
      checkedSize = treeIds.size
      for (const run of runs.values()) {
        if (run.parentRunId && treeIds.has(run.parentRunId)) {
          treeIds.add(run.id)
        }
      }
    }
    return treeIds
  }
  const deleteRunTrees = (treeIds: ReadonlySet<string>) => {
    if (treeIds.size === 0) return

    for (const runId of treeIds) {
      runs.delete(runId)
      runLeases.delete(runId)
    }
    for (const [key, runId] of runIdempotencyKeys) {
      if (treeIds.has(runId)) runIdempotencyKeys.delete(key)
    }
    for (const [key, node] of nodes) {
      if (treeIds.has(node.runId)) nodes.delete(key)
    }
    for (const [attemptId, attempt] of attempts) {
      if (treeIds.has(attempt.runId)) attempts.delete(attemptId)
    }
    for (const [key, child] of children) {
      if (
        treeIds.has(child.runId) ||
        (child.childRunId !== undefined && treeIds.has(child.childRunId))
      ) {
        children.delete(key)
      }
    }
    deleteQueueItemsForRunIds(continueRunCommands, treeIds)
    deleteQueueItemsForRunIds(activityCommands, treeIds)
    deleteQueueItemsForRunIds(taskCommands, treeIds)
    deleteClaimedCommandsForRunIds(claimedContinueRunCommands, treeIds)
    deleteClaimedCommandsForRunIds(claimedActivityCommands, treeIds)
    deleteClaimedCommandsForRunIds(claimedTaskCommands, treeIds)
  }
  const deleteQueueItemsForRunIds = <T extends { readonly runId: string }>(
    queue: QueueItem<T>[],
    runIds: ReadonlySet<string>,
  ) => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      if (runIds.has(queue[index]!.payload.runId)) queue.splice(index, 1)
    }
  }
  const deleteClaimedCommandsForRunIds = <T extends { readonly runId: string }>(
    queue: Map<string, ClaimedQueueItem<T>>,
    runIds: ReadonlySet<string>,
  ) => {
    for (const [commandId, item] of queue) {
      if (runIds.has(item.payload.runId)) queue.delete(commandId)
    }
  }
  const sweepDeadCommands = (deadBefore: number) => {
    sweepDeadQueueItems(continueRunCommands, deadBefore)
    sweepDeadQueueItems(activityCommands, deadBefore)
    sweepDeadQueueItems(taskCommands, deadBefore)
  }
  const sweepDeadQueueItems = <T extends { readonly runId: string }>(
    queue: QueueItem<T>[],
    deadBefore: number,
  ) => {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index]!
      if (item.deadAt !== undefined && item.deadAt.getTime() < deadBefore) {
        queue.splice(index, 1)
      }
    }
  }

  const claimQueued = <T>(
    queue: QueueItem<T>[],
    matches: (item: QueueItem<T>) => boolean,
  ): QueueItem<T> | undefined => {
    const index = queue.findIndex(
      (item) => item.deadAt === undefined && matches(item),
    )
    if (index === -1) return undefined
    return queue.splice(index, 1)[0]
  }

  const matchesClaim = (
    stored:
      | Pick<ClaimedAttempt | ClaimedCommand, 'id' | 'leaseToken'>
      | undefined,
    claim: Pick<ClaimedAttempt | ClaimedCommand, 'id' | 'leaseToken'>,
  ) => stored?.leaseToken === claim.leaseToken
  const queueItem = <T>(
    itemId: string,
    payload: T,
    runAt?: Date,
  ): QueueItem<T> => ({
    id: itemId,
    payload,
    ...(runAt === undefined ? {} : { runAt }),
    deliveryCount: 0,
    createdAt: now(),
  })
  const earliestRunAt = (left: Date | undefined, right: Date | undefined) => {
    if (left === undefined || right === undefined) return undefined
    return left <= right ? left : right
  }
  const enqueueContinue = (command: ContinueRunCommand, runAt?: Date) => {
    const existingIndex = continueRunCommands.findIndex(
      (item) => item.payload.runId === command.runId,
    )
    if (existingIndex === -1) {
      continueRunCommands.push(queueItem(id('continue'), command, runAt))
      return
    }

    const existing = continueRunCommands[existingIndex]!
    continueRunCommands[existingIndex] = {
      ...existing,
      payload: command,
      runAt: earliestRunAt(existing.runAt, runAt),
    }
  }
  const releaseQueueItem = <T>(
    item: QueueItem<T>,
    options?: CommandReleaseOptions,
  ): QueueItem<T> => {
    if (options?.error === undefined && options?.reason === undefined) {
      return {
        ...item,
        runAt: new Date(Date.now() + RELEASE_BACKOFF_MS),
      }
    }

    // Unroutable commands back off slower than transient errors: nothing can
    // execute them until a deploy changes the registry, but they must still
    // count toward dead-lettering instead of looping forever.
    const backoffBaseMs =
      options.reason === 'unroutable'
        ? UNROUTABLE_BACKOFF_MS
        : RELEASE_BACKOFF_MS
    const error =
      options.error ??
      new Error('No implementation can execute this workflow command')
    const deliveryCount = item.deliveryCount + 1
    return {
      ...item,
      deliveryCount,
      lastError: toStoredError(error),
      ...(deliveryCount >= maxDeliveries ? { deadAt: now() } : {}),
      runAt: new Date(
        Date.now() +
          Math.min(2 ** deliveryCount * backoffBaseMs, MAX_ERROR_BACKOFF_MS),
      ),
    }
  }
  const mapDeadCommand = (
    item: QueueItem<
      ContinueRunCommand | ActivityAttemptCommand | TaskAttemptCommand
    >,
    kind: DeadWorkflowCommand['kind'],
  ): DeadWorkflowCommand | undefined => {
    if (item.deadAt === undefined) return undefined
    const payload = item.payload
    return {
      id: item.id,
      kind,
      runId: payload.runId,
      workflowName: payload.workflowName,
      ...('taskName' in payload ? { taskName: payload.taskName } : {}),
      ...('activityName' in payload
        ? { activityName: payload.activityName }
        : {}),
      ...('nodeName' in payload ? { nodeName: payload.nodeName } : {}),
      ...('attemptId' in payload ? { attemptId: payload.attemptId } : {}),
      payload,
      deliveryCount: item.deliveryCount,
      ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
      deadAt: item.deadAt,
      createdAt: item.createdAt,
    }
  }
  const requeueDead = <T>(queue: QueueItem<T>[], commandId: string) => {
    const index = queue.findIndex(
      (item) => item.id === commandId && item.deadAt !== undefined,
    )
    if (index === -1) return false
    const item = queue[index]!
    queue[index] = {
      id: item.id,
      payload: item.payload,
      deliveryCount: 0,
      createdAt: item.createdAt,
    }
    return true
  }
  const inspectQueueItem = <T>(item: QueueItem<T>): InspectQueueItem<T> => ({
    id: item.id,
    payload: item.payload,
    ...(item.runAt === undefined ? {} : { runAt: item.runAt }),
  })
  const attemptCommandExists = (attemptId: string) =>
    activityCommands.some((item) => item.payload.attemptId === attemptId) ||
    taskCommands.some((item) => item.payload.attemptId === attemptId) ||
    [...claimedActivityCommands.values()].some(
      (item) => item.payload.attemptId === attemptId,
    ) ||
    [...claimedTaskCommands.values()].some(
      (item) => item.payload.attemptId === attemptId,
    )

  const runCoordinationExecutor: RunCoordinationExecutor = {
    async enqueue(command) {
      enqueueContinue(command)
    },
    async enqueueDelayed(command, runAt) {
      enqueueContinue(command, runAt)
    },
    async claim(worker) {
      const date = now()
      const item = claimQueued(
        continueRunCommands,
        (queued) =>
          worker.workflowNames.includes(queued.payload.workflowName) &&
          (queued.runAt === undefined || queued.runAt <= date),
      )
      if (!item) return null

      const claim = {
        id: item.id,
        command: item.payload,
        leaseToken: id('continue-lease'),
      }
      claimedContinueRunCommands.set(claim.id, {
        ...item,
        leaseToken: claim.leaseToken,
      })
      return claim
    },
    async ack(command) {
      if (!matchesClaim(claimedContinueRunCommands.get(command.id), command)) {
        throw new Error('Stale workflow command ack')
      }
      claimedContinueRunCommands.delete(command.id)
    },
    async release(command, options) {
      const claimed = claimedContinueRunCommands.get(command.id)
      if (!claimed || !matchesClaim(claimed, command)) {
        return
      }

      claimedContinueRunCommands.delete(command.id)
      continueRunCommands.push(releaseQueueItem(claimed, options))
    },
  }

  const claimedAttempt = <T extends AttemptCommand>(
    item: QueueItem<T> | undefined,
  ):
    | {
        readonly claim: ClaimedAttempt
        readonly item: ClaimedQueueItem<T>
      }
    | undefined => {
    if (!item) return undefined

    const leaseToken = id('attempt-claim-lease')
    return {
      claim: {
        id: item.id,
        command: item.payload,
        leaseToken,
      },
      item: {
        ...item,
        leaseToken,
      },
    }
  }

  const attemptExecutor: AttemptExecutor = {
    async dispatchActivity(command, options) {
      if (attemptCommandExists(command.attemptId)) return
      activityCommands.push(
        queueItem(id('activity-command'), command, options?.runAt),
      )
    },
    async dispatchTask(command, options) {
      if (attemptCommandExists(command.attemptId)) return
      taskCommands.push(queueItem(id('task-command'), command, options?.runAt))
    },
    async claimActivity(worker) {
      const date = now()
      const claimed = claimedAttempt(
        claimQueued(activityCommands, (queued) => {
          const command = queued.payload
          return (
            worker.workflowNames.includes(command.workflowName) &&
            (queued.runAt === undefined || queued.runAt <= date) &&
            (worker.activityNames === undefined ||
              worker.activityNames.includes(command.activityName))
          )
        }),
      )
      if (!claimed) return null
      claimedActivityCommands.set(claimed.claim.id, claimed.item)
      return claimed.claim
    },
    async claimTask(worker) {
      const date = now()
      const claimed = claimedAttempt(
        claimQueued(
          taskCommands,
          (queued) =>
            worker.taskNames.includes(queued.payload.taskName) &&
            (queued.runAt === undefined || queued.runAt <= date),
        ),
      )
      if (!claimed) return null
      claimedTaskCommands.set(claimed.claim.id, claimed.item)
      return claimed.claim
    },
    async heartbeat(attempt) {
      const inFlight =
        attempt.command.kind === 'activityAttempt'
          ? claimedActivityCommands
          : claimedTaskCommands
      if (!matchesClaim(inFlight.get(attempt.id), attempt)) {
        throw new Error('Workflow attempt heartbeat lease lost')
      }
      return { runStatus: runs.get(attempt.command.runId)?.status ?? 'queued' }
    },
    async ack(attempt) {
      const inFlight =
        attempt.command.kind === 'activityAttempt'
          ? claimedActivityCommands
          : claimedTaskCommands
      if (!matchesClaim(inFlight.get(attempt.id), attempt)) {
        throw new Error('Stale workflow command ack')
      }
      inFlight.delete(attempt.id)
    },
    async release(attempt, options) {
      if (attempt.command.kind === 'activityAttempt') {
        const claimed = claimedActivityCommands.get(attempt.id)
        if (!claimed || !matchesClaim(claimed, attempt)) {
          return
        }

        claimedActivityCommands.delete(attempt.id)
        activityCommands.push(releaseQueueItem(claimed, options))
        return
      }

      const claimed = claimedTaskCommands.get(attempt.id)
      if (!claimed || !matchesClaim(claimed, attempt)) {
        return
      }

      claimedTaskCommands.delete(attempt.id)
      taskCommands.push(releaseQueueItem(claimed, options))
    },
    async deleteUnclaimed({ runId }) {
      const deleteQueued = <T extends AttemptCommand>(
        queue: QueueItem<T>[],
      ) => {
        let deleted = 0
        for (let index = queue.length - 1; index >= 0; index -= 1) {
          if (queue[index]?.payload.runId !== runId) continue
          queue.splice(index, 1)
          deleted += 1
        }
        return deleted
      }

      return deleteQueued(activityCommands) + deleteQueued(taskCommands)
    },
  }

  const atomicStart: WorkflowRuntimeAtomicStart = {
    async startWorkflowRun({ run, startAt }) {
      const started = createRunWithState(run)
      if (!started.created) return started.run

      const command = {
        kind: 'continueRun',
        runId: started.run.id,
        workflowName: started.run.workflowName,
      } as const
      if (startAt) {
        await runCoordinationExecutor.enqueueDelayed(command, startAt)
      } else {
        await runCoordinationExecutor.enqueue(command)
      }
      return started.run
    },
    async startTaskRun({ run, taskName, taskInput, idempotencyKey, startAt }) {
      const started = createRunWithState(run)
      if (!started.created) return started.run

      await dispatchTaskRunAttempt({
        store,
        runCoordinationExecutor,
        attemptExecutor,
        taskName,
        taskRunId: started.run.id,
        taskInput,
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
        startAt,
        throwOnDispatchFailure: true,
      })
      return started.run
    },
  }

  const scheduler: WorkflowScheduler = {
    async reconcile(entries) {
      const date = now()
      const normalizedEntries = normalizeScheduleDefinitions(entries, date)
      const names = new Set(normalizedEntries.map((entry) => entry.name))
      for (const scheduleName of schedules.keys()) {
        if (!names.has(scheduleName)) schedules.delete(scheduleName)
      }

      for (const normalized of normalizedEntries) {
        const existing = schedules.get(normalized.name)
        const shouldResetNextRunAt =
          existing === undefined ||
          existing.cron !== normalized.cron ||
          existing.everyMs !== normalized.everyMs ||
          (!existing.enabled &&
            normalized.enabled &&
            existing.nextRunAt <= date)
        schedules.set(normalized.name, {
          id: existing?.id ?? id('schedule'),
          name: normalized.name,
          runnableKind: normalized.runnableKind,
          runnableName: normalized.runnableName,
          input: normalized.input,
          tags: normalized.tags,
          ...(normalized.cron === undefined ? {} : { cron: normalized.cron }),
          ...(normalized.everyMs === undefined
            ? {}
            : { everyMs: normalized.everyMs }),
          enabled: normalized.enabled,
          nextRunAt: shouldResetNextRunAt
            ? normalized.nextRunAt
            : existing.nextRunAt,
          ...(existing?.lastSlotAt === undefined
            ? {}
            : { lastSlotAt: existing.lastSlotAt }),
          createdAt: existing?.createdAt ?? date,
          updatedAt: date,
        })
      }
    },
    async fireDue(options = {}) {
      const date = options.now ?? now()
      const limit = normalizeScheduleLimit(options.limit)
      if (limit < 1) return { fired: 0 }
      const due = [...schedules.values()]
        .filter((schedule) => schedule.enabled && schedule.nextRunAt <= date)
        .sort(compareSchedulesByDueDate)
        .slice(0, limit)

      for (const schedule of due) {
        const slot = schedule.nextRunAt
        await startStoredScheduleRun(
          { store, runCoordinationExecutor, attemptExecutor },
          schedule,
          slot,
        )
        const updated: StoredWorkflowSchedule = {
          ...schedule,
          lastSlotAt: slot,
          nextRunAt: nextStoredScheduleRunAt(schedule, date),
          updatedAt: now(),
        }
        schedules.set(schedule.name, updated)
      }

      return { fired: due.length }
    },
    async list() {
      return [...schedules.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      )
    },
    async trigger(name) {
      const schedule = schedules.get(name)
      if (!schedule) throw new Error(`Unknown workflow schedule [${name}]`)
      return startStoredScheduleRun(
        { store, runCoordinationExecutor, attemptExecutor },
        schedule,
        now(),
      )
    },
    async setEnabled(name, enabled) {
      const schedule = schedules.get(name)
      if (!schedule) throw new Error(`Unknown workflow schedule [${name}]`)
      const date = now()
      const updated = {
        ...schedule,
        enabled,
        nextRunAt:
          enabled && !schedule.enabled && schedule.nextRunAt <= date
            ? nextStoredScheduleRunAt(schedule, date)
            : schedule.nextRunAt,
        updatedAt: date,
      }
      schedules.set(name, updated)
      return updated
    },
  }

  return {
    store,
    retentionPruner: store,
    runCoordinationExecutor,
    attemptExecutor,
    atomicStart,
    scheduler,
    inspect: () => ({
      runs: [...runs.values()],
      nodes: [...nodes.values()],
      children: [...children.values()],
      attempts: [...attempts.values()],
      continueRunCommands: continueRunCommands.map(inspectQueueItem),
      activityCommands: activityCommands.map(inspectQueueItem),
      taskCommands: taskCommands.map(inspectQueueItem),
      schedules: [...schedules.values()],
    }),
  }
}

function compareSchedulesByDueDate(
  left: StoredWorkflowSchedule,
  right: StoredWorkflowSchedule,
) {
  const byDate = left.nextRunAt.getTime() - right.nextRunAt.getTime()
  if (byDate !== 0) return byDate
  return left.name.localeCompare(right.name)
}
