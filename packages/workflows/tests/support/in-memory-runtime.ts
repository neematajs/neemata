import type {
  ActivityAttemptCommand,
  AttemptCommand,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  TaskAttemptCommand,
} from '../../src/runtime/commands.ts'
import type {
  AttemptExecutor,
  RunCoordinationExecutor,
} from '../../src/runtime/executors.ts'
import type {
  CreateAttemptInput,
  CreateNodeInput,
  CreateRunInput,
  RunLease,
  WorkflowStore,
} from '../../src/runtime/store.ts'
import type {
  NodeChildIdentity,
  RunSnapshot,
  StoredAttempt,
  StoredChildLink,
  StoredError,
  StoredMapItem,
  StoredNode,
  StoredRun,
} from '../../src/runtime/state.ts'
import {
  isTerminalNodeStatus,
  isTerminalRunStatus,
} from '../../src/runtime/status.ts'

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
  const mapItemKeys = new Map<string, readonly (string | undefined)[]>()
  const runLeases = new Map<string, InMemoryRunLease>()
  const continueRunCommands: QueueItem<ContinueRunCommand>[] = []
  const activityCommands: QueueItem<ActivityAttemptCommand>[] = []
  const taskCommands: QueueItem<TaskAttemptCommand>[] = []
  const claimedContinueRunCommands = new Map<string, ClaimedCommand>()
  const claimedActivityCommands = new Map<string, ClaimedAttempt>()
  const claimedTaskCommands = new Map<string, ClaimedAttempt>()

  const nodeKey = (runId: string, nodeName: string) => `${runId}:${nodeName}`
  const identityKey = (identity: NodeChildIdentity) =>
    JSON.stringify([
      identity.runId,
      identity.nodeName,
      identity.caseKey ?? null,
      identity.memberKey ?? null,
      identity.itemIndex ?? null,
      identity.itemKey ?? null,
    ])

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
    async ensureNodeAttempt(params) {
      const key = identityKey(params.identity)
      const existing = [...attempts.values()].find(
        (attempt) => attempt.identity && identityKey(attempt.identity) === key,
      )
      if (existing) return { attempt: existing, created: false }

      const node = nodes.get(
        nodeKey(params.identity.runId, params.identity.nodeName),
      )
      if (!node) {
        throw new Error(
          `Missing node [${params.identity.runId}.${params.identity.nodeName}]`,
        )
      }
      const attempt: StoredAttempt = {
        id: id('attempt'),
        runId: params.identity.runId,
        nodeName: params.identity.nodeName,
        identity: params.identity,
        status: 'started',
        leaseToken: id('attempt-lease'),
        attemptNumber: node.attemptCount + 1,
        input: params.input,
        dispatchedAt: now(),
      }
      const updatedNode: StoredNode = {
        ...node,
        status: 'waiting',
        currentAttemptId: attempt.id,
        attemptCount: node.attemptCount + 1,
        version: node.version + 1,
        updatedAt: now(),
      }

      attempts.set(attempt.id, attempt)
      nodes.set(nodeKey(node.runId, node.name), updatedNode)
      return { attempt, created: true }
    },
    async ensureChildWorkflowRun(params) {
      const key = identityKey(params.identity)
      const existingLink = childLinks.find(
        (link) => identityKey(link.identity) === key,
      )
      if (existingLink) {
        const childRun = runs.get(existingLink.childRunId)
        if (!childRun) {
          throw new Error(`Missing child run [${existingLink.childRunId}]`)
        }
        return { childLink: existingLink, childRun, created: false }
      }

      const childRun = await store.createRun({
        workflowName: params.workflowName,
        input: params.input,
        parentRunId: params.parentRunId,
        parentNodeName: params.parentNodeName,
        rootRunId: params.rootRunId,
        tags: params.tags,
        idempotencyKey: params.idempotencyKey,
      })
      const childLink: StoredChildLink = {
        identity: params.identity,
        parentRunId: params.parentRunId,
        parentNodeName: params.parentNodeName,
        childRunId: childRun.id,
        workflowName: params.workflowName,
        ...(params.identity.caseKey === undefined
          ? {}
          : { caseKey: params.identity.caseKey }),
        ...(params.identity.memberKey === undefined
          ? {}
          : { memberKey: params.identity.memberKey }),
        ...(params.identity.itemIndex === undefined
          ? {}
          : { itemIndex: params.identity.itemIndex }),
        ...(params.identity.itemKey === undefined
          ? {}
          : { itemKey: params.identity.itemKey }),
      }
      childLinks.push(childLink)
      return { childLink, childRun, created: true }
    },
    async ensureMapItems(params) {
      const key = nodeKey(params.runId, params.nodeName)
      if (params.keys && params.keys.length !== params.items.length) {
        throw new Error(`Conflicting map items for [${key}]`)
      }

      const keys = params.items.map((_, index) => params.keys?.[index])
      const existingKeys = mapItemKeys.get(key)
      const existingItems = mapItems.filter(
        (item) => item.runId === params.runId && item.nodeName === params.nodeName,
      )
      if (existingKeys) {
        const sameKeys =
          existingKeys.length === keys.length &&
          existingKeys.every((existingKey, index) => existingKey === keys[index])
        if (!sameKeys) throw new Error(`Conflicting map items for [${key}]`)

        return { items: existingItems, created: false }
      }

      mapItemKeys.set(key, keys)
      const createdItems = params.items.map((item, index): StoredMapItem => {
        const itemKey = params.keys?.[index]
        const identity: NodeChildIdentity = {
          runId: params.runId,
          nodeName: params.nodeName,
          itemIndex: index,
          ...(itemKey === undefined ? {} : { itemKey }),
        }
        return {
          identity,
          runId: params.runId,
          nodeName: params.nodeName,
          index,
          ...(itemKey === undefined ? {} : { key: itemKey }),
          item,
          status: 'pending',
        }
      })
      mapItems.push(...createdItems)
      return { items: createdItems, created: true }
    },
    async completeMapItem(params) {
      const index = mapItems.findIndex(
        (item) =>
          item.runId === params.runId &&
          item.nodeName === params.nodeName &&
          item.index === params.itemIndex &&
          item.key === params.itemKey,
      )
      if (index === -1) return undefined

      const item = mapItems[index]!
      if (isTerminalNodeStatus(item.status)) return item

      const updated: StoredMapItem = {
        ...item,
        status: 'completed',
        output: params.output,
      }
      mapItems[index] = updated
      return updated
    },
    async failMapItem(params) {
      const index = mapItems.findIndex(
        (item) =>
          item.runId === params.runId &&
          item.nodeName === params.nodeName &&
          item.index === params.itemIndex &&
          item.key === params.itemKey,
      )
      if (index === -1) return undefined

      const item = mapItems[index]!
      if (isTerminalNodeStatus(item.status)) return item

      const updated: StoredMapItem = {
        ...item,
        status: 'failed',
        error: storedError(params.error),
      }
      mapItems[index] = updated
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
        attempts: [...attempts.values()].filter(
          (attempt) => attempt.runId === runId && attempt.nodeName === nodeName,
        ),
        childLinks: childLinks.filter(
          (link) =>
            link.parentRunId === runId && link.parentNodeName === nodeName,
        ),
        mapItems: mapItems.filter(
          (item) => item.runId === runId && item.nodeName === nodeName,
        ),
      }
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
