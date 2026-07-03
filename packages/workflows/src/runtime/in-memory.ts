import type {
  ActivityAttemptCommand,
  AttemptCommand,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  TaskAttemptCommand,
} from './commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type {
  NodeChildIdentity,
  RunSnapshot,
  StoredAttempt,
  StoredChildLink,
  StoredMapItem,
  StoredNode,
  StoredRun,
} from './state.ts'
import type {
  CreateAttemptInput,
  CreateNodeInput,
  CreateRunInput,
  ListRunsFilter,
  RunLease,
  WorkflowStore,
} from './store.ts'
import { toStoredError } from './errors.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from './status.ts'

type InMemoryRunLease = RunLease & {
  readonly expiresAt: Date
}

type QueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly runAt?: Date
}

const RELEASE_BACKOFF_MS = 50

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
  const runIdempotencyKeys = new Map<string, string>()
  const runLeases = new Map<string, InMemoryRunLease>()
  const continueRunCommands: QueueItem<ContinueRunCommand>[] = []
  const activityCommands: QueueItem<ActivityAttemptCommand>[] = []
  const taskCommands: QueueItem<TaskAttemptCommand>[] = []
  const claimedContinueRunCommands = new Map<string, ClaimedCommand>()
  const claimedActivityCommands = new Map<string, ClaimedAttempt>()
  const claimedTaskCommands = new Map<string, ClaimedAttempt>()

  const nodeKey = (runId: string, nodeName: string) => `${runId}:${nodeName}`
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
  const identityKey = (identity: NodeChildIdentity) =>
    valueKey([
      identity.runId,
      identity.nodeName,
      identity.caseKey ?? null,
      identity.memberKey ?? null,
      identity.itemIndex ?? null,
      identity.itemKey ?? null,
    ])
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

  const store: WorkflowStore = {
    async createRun(input: CreateRunInput) {
      if (input.idempotencyKey) {
        const existingRunId = runIdempotencyKeys.get(
          runIdempotencyKey(input.idempotencyKey),
        )
        if (existingRunId) {
          const existing = runs.get(existingRunId)
          if (existing && runMatchesCreateInput(existing, input)) {
            return existing
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
      return run
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
      const key = nodeKey(input.runId, input.nodeName)
      const node = nodes.get(key)
      if (!node)
        throw new Error(`Missing node [${input.runId}.${input.nodeName}]`)
      if (isTerminalNodeStatus(node.status)) {
        throw new Error(
          `Terminal node [${input.runId}.${input.nodeName}] cannot create attempt`,
        )
      }

      const attempt: StoredAttempt = {
        id: id('attempt'),
        runId: input.runId,
        nodeName: input.nodeName,
        status: 'started',
        leaseToken: id('attempt-lease'),
        attemptNumber: node.attemptCount + 1,
        input: input.input,
        ...(input.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: input.idempotencyKey }),
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
      if (attempt.status !== 'started') return undefined

      const node = nodes.get(nodeKey(attempt.runId, attempt.nodeName))
      if (
        !node ||
        isTerminalNodeStatus(node.status) ||
        (node.kind !== 'parallel' && node.currentAttemptId !== attemptId)
      ) {
        return undefined
      }

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
      if (attempt.status !== 'started') return undefined

      const node = nodes.get(nodeKey(attempt.runId, attempt.nodeName))
      if (
        !node ||
        isTerminalNodeStatus(node.status) ||
        (node.kind !== 'parallel' && node.currentAttemptId !== attemptId)
      ) {
        return undefined
      }

      const updated: StoredAttempt = {
        ...attempt,
        status: 'failed',
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
      return updated
    },
    async ensureNodeAttempt(params) {
      const key = identityKey(params.identity)
      const node = nodes.get(
        nodeKey(params.identity.runId, params.identity.nodeName),
      )
      if (!node) {
        throw new Error(
          `Missing node [${params.identity.runId}.${params.identity.nodeName}]`,
        )
      }
      if (
        (node.kind === 'activity' || node.kind === 'task') &&
        node.kind !== params.kind
      ) {
        throw new Error(
          `Node [${node.runId}.${node.name}] kind [${node.kind}] cannot create [${params.kind}] attempt`,
        )
      }
      const existing = [...attempts.values()].find(
        (attempt) => attempt.identity && identityKey(attempt.identity) === key,
      )
      if (existing) return { attempt: existing, created: false }
      if (isTerminalNodeStatus(node.status)) {
        throw new Error(
          `Terminal node [${params.identity.runId}.${params.identity.nodeName}] cannot create attempt`,
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
        ...(params.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: params.idempotencyKey }),
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
    async ensureChildRun(params) {
      if (
        params.identity.runId !== params.parentRunId ||
        params.identity.nodeName !== params.parentNodeName
      ) {
        throw new Error(
          `Child identity does not match parent node [${params.parentRunId}.${params.parentNodeName}]`,
        )
      }

      const key = identityKey(params.identity)
      const existingLink = childLinks.find(
        (link) => identityKey(link.identity) === key,
      )
      if (existingLink) {
        const childRun = runs.get(existingLink.childRunId)
        if (!childRun) {
          throw new Error(`Missing child run [${existingLink.childRunId}]`)
        }
        if (
          existingLink.childKind !== params.childKind ||
          existingLink.childName !== params.childName ||
          childRun.kind !== params.childKind ||
          childRun.name !== params.childName ||
          !sameValue(childRun.input, params.input) ||
          !sameOptionalValue(childRun.idempotencyKey, params.idempotencyKey)
        ) {
          throw new Error(
            `Conflicting child run [${params.parentRunId}.${params.parentNodeName}]`,
          )
        }
        return { childLink: existingLink, childRun, created: false }
      }

      const childRun = await store.createRun({
        kind: params.childKind,
        name: params.childName,
        workflowName: params.childName,
        ...(params.childKind === 'task' ? { taskName: params.childName } : {}),
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
        childKind: params.childKind,
        childName: params.childName,
        workflowName: params.childName,
        ...(params.childKind === 'task' ? { taskName: params.childName } : {}),
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
    async ensureChildWorkflowRun(params) {
      return store.ensureChildRun({
        identity: params.identity,
        childKind: 'workflow',
        childName: params.workflowName,
        input: params.input,
        parentRunId: params.parentRunId,
        parentNodeName: params.parentNodeName,
        rootRunId: params.rootRunId,
        tags: params.tags,
        idempotencyKey: params.idempotencyKey,
      })
    },
    async ensureMapItems(params) {
      const key = nodeKey(params.runId, params.nodeName)
      if (params.keys && params.keys.length !== params.items.length) {
        throw new Error(`Conflicting map items for [${key}]`)
      }

      const keys = params.items.map((_, index) => params.keys?.[index])
      const definedKeys = keys.filter((itemKey) => itemKey !== undefined)
      if (new Set(definedKeys).size !== definedKeys.length) {
        throw new Error(`Duplicate map item key for [${key}]`)
      }
      const existingKeys = mapItemKeys.get(key)
      const existingItems = mapItems.filter(
        (item) =>
          item.runId === params.runId && item.nodeName === params.nodeName,
      )
      if (existingKeys) {
        const sameKeys =
          existingKeys.length === keys.length &&
          existingKeys.every(
            (existingKey, index) => existingKey === keys[index],
          )
        if (!sameKeys) throw new Error(`Conflicting map items for [${key}]`)
        const sameItems =
          existingItems.length === params.items.length &&
          existingItems.every((existingItem, index) =>
            sameValue(existingItem.item, params.items[index]),
          )
        if (!sameItems) throw new Error(`Conflicting map items for [${key}]`)

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
        error: toStoredError(params.error),
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
    stored:
      | Pick<ClaimedAttempt | ClaimedCommand, 'id' | 'leaseToken'>
      | undefined,
    claim: Pick<ClaimedAttempt | ClaimedCommand, 'id' | 'leaseToken'>,
  ) => stored?.leaseToken === claim.leaseToken
  const attemptCommandExists = (attemptId: string) =>
    activityCommands.some((item) => item.payload.attemptId === attemptId) ||
    taskCommands.some((item) => item.payload.attemptId === attemptId) ||
    [...claimedActivityCommands.values()].some(
      (item) => item.command.attemptId === attemptId,
    ) ||
    [...claimedTaskCommands.values()].some(
      (item) => item.command.attemptId === attemptId,
    )

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
      claimedContinueRunCommands.set(claim.id, claim)
      return claim
    },
    async ack(command) {
      if (!matchesClaim(claimedContinueRunCommands.get(command.id), command)) {
        throw new Error('Stale workflow command ack')
      }
      claimedContinueRunCommands.delete(command.id)
    },
    async release(command) {
      if (!matchesClaim(claimedContinueRunCommands.get(command.id), command)) {
        return
      }

      claimedContinueRunCommands.delete(command.id)
      continueRunCommands.push({
        id: command.id,
        payload: command.command,
        runAt: new Date(Date.now() + RELEASE_BACKOFF_MS),
      })
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
    async dispatchActivity(command, options) {
      if (attemptCommandExists(command.attemptId)) return
      activityCommands.push({
        id: id('activity-command'),
        payload: command,
        ...(options?.runAt === undefined ? {} : { runAt: options.runAt }),
      })
    },
    async dispatchTask(command, options) {
      if (attemptCommandExists(command.attemptId)) return
      taskCommands.push({
        id: id('task-command'),
        payload: command,
        ...(options?.runAt === undefined ? {} : { runAt: options.runAt }),
      })
    },
    async claimActivity(worker) {
      const date = now()
      const claim = claimedAttempt(
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
      if (claim) claimedActivityCommands.set(claim.id, claim)
      return claim
    },
    async claimTask(worker) {
      const date = now()
      const claim = claimedAttempt(
        claimQueued(
          taskCommands,
          (queued) =>
            worker.taskNames.includes(queued.payload.taskName) &&
            (queued.runAt === undefined || queued.runAt <= date),
        ),
      )
      if (claim) claimedTaskCommands.set(claim.id, claim)
      return claim
    },
    async heartbeat(attempt) {
      const inFlight =
        attempt.command.kind === 'activityAttempt'
          ? claimedActivityCommands
          : claimedTaskCommands
      if (!matchesClaim(inFlight.get(attempt.id), attempt)) {
        throw new Error('Workflow attempt heartbeat lease lost')
      }
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
    async release(attempt) {
      if (attempt.command.kind === 'activityAttempt') {
        if (!matchesClaim(claimedActivityCommands.get(attempt.id), attempt)) {
          return
        }

        claimedActivityCommands.delete(attempt.id)
        activityCommands.push({
          id: attempt.id,
          payload: attempt.command,
          runAt: new Date(Date.now() + RELEASE_BACKOFF_MS),
        })
        return
      }

      if (!matchesClaim(claimedTaskCommands.get(attempt.id), attempt)) {
        return
      }

      claimedTaskCommands.delete(attempt.id)
      taskCommands.push({
        id: attempt.id,
        payload: attempt.command,
        runAt: new Date(Date.now() + RELEASE_BACKOFF_MS),
      })
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
