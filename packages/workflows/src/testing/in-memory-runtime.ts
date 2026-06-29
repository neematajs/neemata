import type {
  ActivityAttemptCommand,
  AttemptCommand,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  TaskAttemptCommand,
} from '../runtime/commands.ts'
import type {
  AttemptExecutor,
  RunCoordinationExecutor,
} from '../runtime/executors.ts'
import type {
  CreateAttemptInput,
  CreateNodeInput,
  CreateRunInput,
  RunLease,
  WorkflowStore,
} from '../runtime/store.ts'
import type {
  RunSnapshot,
  StoredAttempt,
  StoredChildLink,
  StoredError,
  StoredMapItem,
  StoredNode,
  StoredRun,
} from '../runtime/state.ts'
import {
  isTerminalNodeStatus,
  isTerminalRunStatus,
} from '../runtime/status.ts'

type InMemoryRunLease = RunLease & {
  readonly expiresAt: Date
}

type QueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly runAt?: Date
}

export type InMemoryWorkflowRuntime = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
  readonly inspect: () => {
    readonly runs: readonly StoredRun[]
    readonly nodes: readonly StoredNode[]
    readonly attempts: readonly StoredAttempt[]
    readonly continueRunCommands: readonly QueueItem<ContinueRunCommand>[]
    readonly activityCommands: readonly QueueItem<ActivityAttemptCommand>[]
    readonly taskCommands: readonly QueueItem<TaskAttemptCommand>[]
  }
}

export function createInMemoryWorkflowRuntime(): InMemoryWorkflowRuntime {
  let nextId = 1
  const id = (prefix: string) => `${prefix}-${nextId++}`
  const now = () => new Date()

  const runs = new Map<string, StoredRun>()
  const nodes = new Map<string, StoredNode>()
  const attempts = new Map<string, StoredAttempt>()
  const childLinks: StoredChildLink[] = []
  const mapItems: StoredMapItem[] = []
  const runLeases = new Map<string, InMemoryRunLease>()
  const continueRunCommands: QueueItem<ContinueRunCommand>[] = []
  const activityCommands: QueueItem<ActivityAttemptCommand>[] = []
  const taskCommands: QueueItem<TaskAttemptCommand>[] = []
  const claimedContinueRunCommands = new Map<string, ClaimedCommand>()
  const claimedActivityCommands = new Map<string, ClaimedAttempt>()
  const claimedTaskCommands = new Map<string, ClaimedAttempt>()

  const nodeKey = (runId: string, nodeName: string) => `${runId}:${nodeName}`

  const storedError = (error: unknown): StoredError => {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
        stack: error.stack,
      }
    }

    return { message: String(error) }
  }

  const store: WorkflowStore = {
    async createRun(input: CreateRunInput) {
      const date = now()
      const runId = id('run')
      const run: StoredRun = {
        id: runId,
        workflowName: input.workflowName,
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
      return run
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
    async releaseRunLease(lease) {
      if (runLeases.get(lease.runId)?.leaseToken === lease.leaseToken) {
        runLeases.delete(lease.runId)
      }
    },
    async loadRunSnapshot(runId) {
      const run = runs.get(runId)
      if (!run) return undefined

      const snapshot: RunSnapshot = {
        run,
        nodes: [...nodes.values()].filter((node) => node.runId === runId),
        attempts: [...attempts.values()].filter(
          (attempt) => attempt.runId === runId,
        ),
        childLinks: childLinks.filter((link) => link.parentRunId === runId),
        mapItems: mapItems.filter((item) => item.runId === runId),
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
        attemptCount: 0,
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
    async createAttempt(input: CreateAttemptInput) {
      const key = nodeKey(input.runId, input.nodeName)
      const node = nodes.get(key)
      if (!node) throw new Error(`Missing node [${input.runId}.${input.nodeName}]`)

      const attempt: StoredAttempt = {
        id: id('attempt'),
        runId: input.runId,
        nodeName: input.nodeName,
        status: 'started',
        leaseToken: id('attempt-lease'),
        attemptNumber: node.attemptCount + 1,
        input: input.input,
        dispatchedAt: now(),
      }
      const updatedNode: StoredNode = {
        ...node,
        status: 'running',
        currentAttemptId: attempt.id,
        attemptCount: node.attemptCount + 1,
        version: node.version + 1,
        updatedAt: now(),
      }

      attempts.set(attempt.id, attempt)
      nodes.set(key, updatedNode)
      return attempt
    },
    async completeCurrentAttempt({ attemptId, leaseToken, output }) {
      const attempt = attempts.get(attemptId)
      if (!attempt || attempt.leaseToken !== leaseToken) return undefined

      const node = nodes.get(nodeKey(attempt.runId, attempt.nodeName))
      if (!node || node.currentAttemptId !== attemptId) return undefined

      const updated: StoredAttempt = {
        ...attempt,
        status: 'completed',
        output,
        completedAt: now(),
      }
      attempts.set(attemptId, updated)
      return updated
    },
    async failCurrentAttempt({ attemptId, leaseToken, error }) {
      const attempt = attempts.get(attemptId)
      if (!attempt || attempt.leaseToken !== leaseToken) return undefined

      const node = nodes.get(nodeKey(attempt.runId, attempt.nodeName))
      if (!node || node.currentAttemptId !== attemptId) return undefined

      const updated: StoredAttempt = {
        ...attempt,
        status: 'failed',
        error: storedError(error),
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
        error: storedError(error),
        version: node.version + 1,
        updatedAt: now(),
      }
      nodes.set(key, updated)
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
        error: storedError(error),
        version: run.version + 1,
        updatedAt: now(),
      }
      runs.set(runId, updated)
      return updated
    },
  }

  const claimQueued = <T>(
    queue: QueueItem<T>[],
    matches: (item: QueueItem<T>) => boolean,
  ): QueueItem<T> | undefined => {
    const index = queue.findIndex(matches)
    if (index === -1) return undefined
    return queue.splice(index, 1)[0]
  }

  const matchesClaim = (
    stored: Pick<ClaimedAttempt | ClaimedCommand, 'id' | 'leaseToken'> | undefined,
    claim: Pick<ClaimedAttempt | ClaimedCommand, 'id' | 'leaseToken'>,
  ) => stored?.leaseToken === claim.leaseToken

  const runCoordinationExecutor: RunCoordinationExecutor = {
    async enqueue(command) {
      continueRunCommands.push({ id: id('continue'), payload: command })
    },
    async enqueueDelayed(command, runAt) {
      continueRunCommands.push({
        id: id('continue'),
        payload: command,
        runAt,
      })
    },
    async claim(worker) {
      const date = now()
      const item = claimQueued(continueRunCommands, (queued) =>
        worker.workflowNames.includes(queued.payload.workflowName) &&
        (queued.runAt === undefined || queued.runAt <= date),
      )
      if (!item) return null

      const claim = {
        id: item.id,
        command: item.payload,
        leaseToken: id('continue-lease'),
      }
      claimedContinueRunCommands.set(claim.id, claim)
      return claim
    },
    async ack(command) {
      if (matchesClaim(claimedContinueRunCommands.get(command.id), command)) {
        claimedContinueRunCommands.delete(command.id)
      }
    },
    async release(command) {
      if (!matchesClaim(claimedContinueRunCommands.get(command.id), command)) {
        return
      }

      claimedContinueRunCommands.delete(command.id)
      continueRunCommands.push({ id: command.id, payload: command.command })
    },
  }

  const claimedAttempt = (
    item: QueueItem<AttemptCommand> | undefined,
  ): ClaimedAttempt | null => {
    if (!item) return null

    return {
      id: item.id,
      command: item.payload,
      leaseToken: id('attempt-claim-lease'),
    }
  }

  const attemptExecutor: AttemptExecutor = {
    async dispatchActivity(command) {
      activityCommands.push({ id: id('activity-command'), payload: command })
    },
    async dispatchTask(command) {
      taskCommands.push({ id: id('task-command'), payload: command })
    },
    async claimActivity(worker) {
      const claim = claimedAttempt(
        claimQueued(activityCommands, (queued) => {
          const command = queued.payload
          return (
            worker.workflowNames.includes(command.workflowName) &&
            (worker.activityNames === undefined ||
              worker.activityNames.includes(command.activityName))
          )
        }),
      )
      if (claim) claimedActivityCommands.set(claim.id, claim)
      return claim
    },
    async claimTask(worker) {
      const claim = claimedAttempt(
        claimQueued(taskCommands, (queued) =>
          worker.taskNames.includes(queued.payload.taskName),
        )
      )
      if (claim) claimedTaskCommands.set(claim.id, claim)
      return claim
    },
    async heartbeat() {},
    async ack(attempt) {
      const inFlight =
        attempt.command.kind === 'activityAttempt'
          ? claimedActivityCommands
          : claimedTaskCommands
      if (matchesClaim(inFlight.get(attempt.id), attempt)) {
        inFlight.delete(attempt.id)
      }
    },
    async release(attempt) {
      if (attempt.command.kind === 'activityAttempt') {
        if (!matchesClaim(claimedActivityCommands.get(attempt.id), attempt)) {
          return
        }

        claimedActivityCommands.delete(attempt.id)
        activityCommands.push({ id: attempt.id, payload: attempt.command })
        return
      }

      if (!matchesClaim(claimedTaskCommands.get(attempt.id), attempt)) {
        return
      }

      claimedTaskCommands.delete(attempt.id)
      taskCommands.push({ id: attempt.id, payload: attempt.command })
    },
  }

  return {
    store,
    runCoordinationExecutor,
    attemptExecutor,
    inspect: () => ({
      runs: [...runs.values()],
      nodes: [...nodes.values()],
      attempts: [...attempts.values()],
      continueRunCommands: [...continueRunCommands],
      activityCommands: [...activityCommands],
      taskCommands: [...taskCommands],
    }),
  }
}
