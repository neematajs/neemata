import type {
  RunSnapshot,
  StoredAttempt,
  StoredError,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../state.ts'
import type { RuntimeNodeStatus, RuntimeRunStatus } from '../status.ts'
import type {
  AttemptSummary,
  CreateRunInput,
  DeadWorkflowCommand,
  ListRunsFilter,
  NodeChildRef,
  NodeChildSummary,
  NodeSummary,
  RunFamilyEntry,
  RunSummary,
  WorkflowStore,
} from '../store.ts'
import type { State } from './state.ts'
import { SELF_CHILD_KEY, TASK_RUN_NODE_NAME } from '../child-key.ts'
import { continueRun } from '../commands.ts'
import { WorkflowRunConflictError, toStoredError } from '../errors.ts'
import { jsonContains, sameValue, valueKey } from '../json.ts'
import { normalizeBatchSize, normalizePruneStatuses } from '../limits.ts'
import { validateFailedRunRetry } from '../retry-validation.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from '../status.ts'
import {
  NODE_TRANSITIONS,
  RUN_TRANSITIONS,
  canTransition,
} from '../transitions.ts'
import {
  commandQueues,
  dispatchAttempt,
  enqueueContinue,
  findDeadIndex,
  liveContinueIndex,
  mergeContinue,
  queuedCommands,
  removeWhere,
  revive,
  toDeadCommand,
} from './queue.ts'
import {
  childMapKey,
  compareAttempts,
  compareRunsNewest,
  compareRunsOldest,
  describeChild,
  latestAttempt,
  nodeAttempts,
  nodeChildren,
  nodeKey,
  runAttempts,
  runChildren,
  runNodes,
  sortedChildren,
} from './state.ts'

type RunPatch = {
  readonly status: RuntimeRunStatus
  readonly output?: unknown
  readonly error?: StoredError
}

type NodePatch = {
  readonly status?: RuntimeNodeStatus
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly selectedCase?: string
}

type ChildPatch = {
  readonly status?: RuntimeNodeStatus
  readonly output?: unknown
  readonly error?: StoredError
  readonly childRunId?: string
  readonly currentAttemptId?: string
  readonly attemptCount?: number
}

type AttemptPatch = {
  readonly status: StoredAttempt['status']
  readonly output?: unknown
  readonly error?: StoredError
}

/**
 * Creates the run, or returns the existing one an idempotency key or a
 * joinable unique constraint points at.
 */
export function createRun(
  state: State,
  input: CreateRunInput,
): { readonly run: StoredRun; readonly created: boolean } {
  if (input.idempotencyKey) {
    const existingId = state.runIdempotencyKeys.get(
      valueKey(input.idempotencyKey),
    )
    if (existingId) {
      const existing = state.runs.get(existingId)
      if (existing && matchesCreateInput(existing, input)) {
        return { run: existing, created: false }
      }

      throw new Error(`Conflicting idempotent run [${input.workflowName}]`)
    }
  }

  if (input.unique) {
    const uniqueKeys =
      input.unique.scope === 'all'
        ? state.allUniqueRunKeys
        : state.activeUniqueRunKeys
    const conflictingId = uniqueKeys.get(valueKey(input.unique.key))
    const conflicting =
      conflictingId === undefined ? undefined : state.runs.get(conflictingId)
    if (conflicting) {
      if (input.unique.behavior === 'join') {
        return { run: conflicting, created: false }
      }
      throw new WorkflowRunConflictError({
        runId: conflicting.id,
        status: conflicting.status,
        key: input.unique.key,
        scope: input.unique.scope,
      })
    }
  }

  const at = state.now()
  const runId = state.newId('run')
  const run: StoredRun = {
    id: runId,
    kind: input.kind ?? 'workflow',
    name: runnableName(input),
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
    ...(input.unique === undefined ? {} : { unique: input.unique }),
    version: 1,
    activeSince: at,
    createdAt: at,
    updatedAt: at,
  }
  state.runs.set(run.id, run)
  if (input.idempotencyKey) {
    state.runIdempotencyKeys.set(valueKey(input.idempotencyKey), run.id)
  }
  if (input.unique) {
    const uniqueKeys =
      input.unique.scope === 'all'
        ? state.allUniqueRunKeys
        : state.activeUniqueRunKeys
    uniqueKeys.set(valueKey(input.unique.key), run.id)
  }
  state.emitRunEvent(run)

  return { run, created: true }
}

export function createStore(state: State): WorkflowStore {
  const { runs, nodes, children, attempts, now, newId } = state

  // mirrors the partial index predicate: a terminal run leaves the active
  // uniqueness scope and frees its key
  const releaseUniqueKey = (run: StoredRun) => {
    if (run.unique?.scope !== 'active') return
    const key = valueKey(run.unique.key)
    if (state.activeUniqueRunKeys.get(key) === run.id) {
      state.activeUniqueRunKeys.delete(key)
    }
  }

  const transitionRun = (runId: string, patch: RunPatch) => {
    const run = runs.get(runId)
    if (!run) return undefined
    if (!canTransition(RUN_TRANSITIONS, run.status, patch.status)) return run

    const updated: StoredRun = {
      ...run,
      ...patch,
      version: run.version + 1,
      updatedAt: now(),
    }
    runs.set(runId, updated)
    if (isTerminalRunStatus(updated.status)) releaseUniqueKey(updated)
    state.emitRunEvent(updated)
    return updated
  }

  const writeNode = (node: StoredNode, patch: NodePatch) => {
    const updated: StoredNode = {
      ...node,
      ...patch,
      version: node.version + 1,
      updatedAt: now(),
    }
    nodes.set(nodeKey(node.runId, node.name), updated)
    state.emitStatusChange(node, updated)
    return updated
  }

  const transitionNode = (
    runId: string,
    nodeName: string,
    patch: NodePatch & { readonly status: RuntimeNodeStatus },
  ) => {
    const node = nodes.get(nodeKey(runId, nodeName))
    if (!node) return undefined
    if (!canTransition(NODE_TRANSITIONS, node.status, patch.status)) return node

    return writeNode(node, patch)
  }

  const writeChild = (child: StoredNodeChild, patch: ChildPatch) => {
    const updated: StoredNodeChild = {
      ...child,
      ...patch,
      version: child.version + 1,
      updatedAt: now(),
    }
    children.set(childMapKey(child), updated)
    state.emitStatusChange(child, updated)
    return updated
  }

  const transitionChild = (
    ref: NodeChildRef,
    patch: ChildPatch & { readonly status: RuntimeNodeStatus },
  ) => {
    const child = children.get(childMapKey(ref))
    if (!child) return undefined
    if (!canTransition(NODE_TRANSITIONS, child.status, patch.status)) {
      return child
    }

    return writeChild(child, patch)
  }

  const requireChild = (ref: NodeChildRef) => {
    const child = children.get(childMapKey(ref))
    if (!child) {
      throw new Error(`Missing node child [${describeChild(ref)}]`)
    }
    return child
  }

  const settleAttempt = (attempt: StoredAttempt, patch: AttemptPatch) => {
    const updated: StoredAttempt = { ...attempt, ...patch, completedAt: now() }
    attempts.set(attempt.id, updated)
    state.emitStatusChange(attempt, updated)
    return updated
  }

  const createChildAttempt = (
    child: StoredNodeChild,
    input: unknown,
    idempotencyKey: readonly unknown[] | undefined,
  ): StoredAttempt => {
    const previous =
      child.currentAttemptId === undefined
        ? undefined
        : attempts.get(child.currentAttemptId)
    const attempt: StoredAttempt = {
      id: newId('attempt'),
      runId: child.runId,
      nodeName: child.nodeName,
      childKey: child.childKey,
      status: 'started',
      leaseToken: newId('attempt-lease'),
      attemptNumber: child.attemptCount + 1,
      retryAttemptNumber: (previous?.retryAttemptNumber ?? 0) + 1,
      input,
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      dispatchedAt: now(),
    }
    attempts.set(attempt.id, attempt)
    state.emitStatusChange(undefined, attempt)
    writeChild(child, {
      status: 'running',
      currentAttemptId: attempt.id,
      attemptCount: child.attemptCount + 1,
    })

    // Aggregate hint only: the node mirrors "some child is executing" so
    // observers see progress without deriving it from child rows.
    const node = nodes.get(nodeKey(child.runId, child.nodeName))
    // Self-inclusive like the postgres guard, so version bumps stay in
    // lockstep across adapters even when the node is already running.
    if (
      node &&
      (node.status === 'running' ||
        canTransition(NODE_TRANSITIONS, node.status, 'running'))
    ) {
      writeNode(node, { status: 'running' })
    }

    return attempt
  }

  const fencedCurrentAttempt = (attemptId: string, leaseToken: string) => {
    const attempt = attempts.get(attemptId)
    if (!attempt || attempt.leaseToken !== leaseToken) return undefined
    if (attempt.status !== 'started') return undefined

    const child = children.get(childMapKey(attempt))
    if (
      !child ||
      isTerminalNodeStatus(child.status) ||
      child.currentAttemptId !== attemptId
    ) {
      return undefined
    }
    return { attempt, child }
  }

  const runSummary = (run: StoredRun): RunSummary => {
    const { input: _input, output: _output, ...summary } = run
    let nodesTotal = 0
    let nodesCompleted = 0

    for (const node of nodes.values()) {
      if (node.runId !== run.id) continue
      nodesTotal++
      if (node.status === 'completed') nodesCompleted++
    }

    return { ...summary, nodesTotal, nodesCompleted }
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

  const familySnapshots = (runId: string) => {
    const snapshots: RunSnapshot[] = []

    for (const run of runs.values()) {
      if (run.rootRunId !== runId && run.id !== runId) continue
      snapshots.push({
        run,
        nodes: runNodes(state, run.id),
        children: runChildren(state, run.id).sort(
          (left, right) => left.ordinal - right.ordinal,
        ),
        attempts: runAttempts(state, run.id),
      })
    }

    return snapshots
  }

  /** A run with a live lease or an unexpired claim is still executing. */
  const assertIdle = (run: StoredRun) => {
    const at = new Date()
    const lease = state.runLeases.get(run.id)
    if (lease && lease.expiresAt > at) {
      throw new Error(`Run [${run.id}] is busy`)
    }

    for (const claimed of [
      ...state.claimedAttemptCommands.values(),
      ...state.claimedContinueCommands.values(),
    ]) {
      if (claimed.payload.runId === run.id && claimed.leaseExpiresAt > at) {
        throw new Error(`Run [${run.id}] has an active attempt`)
      }
    }

    if (!run.unique) return

    const uniqueKeys =
      run.unique.scope === 'all'
        ? state.allUniqueRunKeys
        : state.activeUniqueRunKeys
    const holder = uniqueKeys.get(valueKey(run.unique.key))
    if (holder && holder !== run.id) {
      throw new WorkflowRunConflictError({
        runId: holder,
        status: runs.get(holder)!.status,
        key: run.unique.key,
        scope: run.unique.scope,
      })
    }
  }

  const reopenFamilyRun = (snapshot: RunSnapshot, at: Date) => {
    const { run } = snapshot
    const updated: StoredRun = {
      ...run,
      status: 'queued',
      error: undefined,
      output: undefined,
      activeSince: at,
      updatedAt: at,
      version: run.version + 1,
    }
    runs.set(run.id, updated)
    state.runLeases.delete(run.id)

    for (const queue of commandQueues(state)) {
      for (let index = queue.length - 1; index >= 0; index--) {
        const item = queue[index]!
        if (item.payload.runId !== run.id) continue
        if (item.deadAt) {
          queue[index] = { ...item, reapedAt: at }
        } else {
          queue.splice(index, 1)
        }
      }
    }
    for (const [commandId, claimed] of state.claimedAttemptCommands) {
      if (claimed.payload.runId === run.id) {
        state.claimedAttemptCommands.delete(commandId)
      }
    }
    for (const [commandId, claimed] of state.claimedContinueCommands) {
      if (claimed.payload.runId === run.id) {
        state.claimedContinueCommands.delete(commandId)
      }
    }

    if (run.unique) {
      const uniqueKeys =
        run.unique.scope === 'all'
          ? state.allUniqueRunKeys
          : state.activeUniqueRunKeys
      uniqueKeys.set(valueKey(run.unique.key), run.id)
    }

    for (const node of snapshot.nodes) {
      if (node.status === 'completed') continue
      nodes.set(nodeKey(run.id, node.name), {
        ...node,
        status: 'pending',
        error: undefined,
        output: undefined,
        updatedAt: at,
        version: node.version + 1,
      })
    }

    for (const child of snapshot.children) {
      if (child.status === 'completed') continue
      const node = snapshot.nodes.find(({ name }) => name === child.nodeName)
      if (node?.status === 'completed') continue
      children.set(childMapKey(child), {
        ...child,
        currentAttemptId: undefined,
        status: 'pending',
        error: undefined,
        output: undefined,
        updatedAt: at,
        version: child.version + 1,
      })
    }

    state.emitRunEvent(updated)
  }

  /** Puts the reopened root back on a queue, as its original start did. */
  const redispatchRoot = (root: StoredRun) => {
    if (root.kind !== 'task') {
      enqueueContinue(state, continueRun(root))
      return
    }

    const child = children.get(
      childMapKey({
        runId: root.id,
        nodeName: TASK_RUN_NODE_NAME,
        childKey: SELF_CHILD_KEY,
      }),
    )!
    const previous = latestAttempt(state, child)!
    const attempt = createChildAttempt(
      child,
      previous.input,
      previous.idempotencyKey,
    )
    dispatchAttempt(state, {
      kind: 'taskAttempt',
      runId: root.id,
      workflowName: root.workflowName,
      taskName: root.taskName ?? root.name,
      nodeName: TASK_RUN_NODE_NAME,
      childKey: child.childKey,
      attemptId: attempt.id,
      leaseToken: attempt.leaseToken!,
      input: attempt.input,
      idempotencyKey: attempt.idempotencyKey,
    })
  }

  const collectRunTreeIds = (rootIds: readonly string[]) => {
    const treeIds = new Set(rootIds)
    let checkedSize = -1

    while (checkedSize !== treeIds.size) {
      checkedSize = treeIds.size
      for (const run of runs.values()) {
        if (run.parentRunId && treeIds.has(run.parentRunId)) treeIds.add(run.id)
      }
    }

    return treeIds
  }

  const collectRunDescendantIds = (rootId: string) => {
    const descendantIds = new Set([rootId])
    let checkedSize = -1

    while (checkedSize !== descendantIds.size) {
      checkedSize = descendantIds.size
      for (const run of runs.values()) {
        if (
          (run.parentRunId !== undefined &&
            descendantIds.has(run.parentRunId)) ||
          descendantIds.has(run.rootRunId)
        ) {
          descendantIds.add(run.id)
        }
      }
    }

    return descendantIds
  }

  const deleteRunTrees = (treeIds: ReadonlySet<string>) => {
    if (treeIds.size === 0) return

    for (const runId of treeIds) {
      runs.delete(runId)
      state.runLeases.delete(runId)
    }
    for (const keys of [
      state.runIdempotencyKeys,
      state.activeUniqueRunKeys,
      state.allUniqueRunKeys,
    ]) {
      for (const [key, runId] of keys) {
        if (treeIds.has(runId)) keys.delete(key)
      }
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
    for (const queue of commandQueues(state)) {
      removeWhere(queue, (item) => treeIds.has(item.payload.runId))
    }
    for (const claimed of [
      state.claimedContinueCommands,
      state.claimedAttemptCommands,
    ]) {
      for (const [commandId, item] of claimed) {
        if (treeIds.has(item.payload.runId)) claimed.delete(commandId)
      }
    }
  }

  const sweepDeadCommands = (deadBefore: number) => {
    for (const queue of commandQueues(state)) {
      removeWhere(
        queue,
        (item) =>
          item.deadAt !== undefined && item.deadAt.getTime() < deadBefore,
      )
    }
  }

  const store: WorkflowStore = {
    async createRun(input) {
      return createRun(state, input).run
    },
    async reopenFailedRun(params) {
      const reopening = validateFailedRunRetry(
        familySnapshots(params.runId),
        params,
      )
      for (const { run } of reopening) assertIdle(run)
      const at = now()

      // No await between validation, reopening and enqueue: observers only see
      // the committed family, and duplicate retries cannot interleave.
      for (const snapshot of reopening) reopenFamilyRun(snapshot, at)

      const root = runs.get(params.runId)!
      redispatchRoot(root)
      return root
    },
    async listRuns(filter = {}) {
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

      const matching = [...runs.values()]
        .filter((run) => matchesFilter(run, filter))
        .sort(compareRunsNewest)
      const page = matching.slice(offset, offset + limit)
      const nextOffset = offset + page.length

      return {
        runs: page,
        ...(nextOffset < matching.length
          ? { nextCursor: String(nextOffset) }
          : {}),
      }
    },
    async listRunSummaries(filter = {}) {
      const result = await store.listRuns(filter)
      return {
        runs: result.runs.map(runSummary),
        ...(result.nextCursor === undefined
          ? {}
          : { nextCursor: result.nextCursor }),
      }
    },
    async pruneTerminalRuns(params) {
      const batchSize = normalizeBatchSize(params.batchSize)
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
            isTerminalRunStatus(run.status) &&
            statuses.includes(run.status) &&
            run.updatedAt < params.olderThan,
        )
        .sort((left, right) => {
          const byUpdatedAt =
            left.updatedAt.getTime() - right.updatedAt.getTime()
          if (byUpdatedAt !== 0) return byUpdatedAt
          return left.id.localeCompare(right.id)
        })
        .slice(0, batchSize)

      deleteRunTrees(collectRunTreeIds(roots.map((run) => run.id)))
      sweepDeadCommands(deadBefore)
      return { deleted: roots.length }
    },
    async deleteRun(runId) {
      const run = runs.get(runId)
      if (!run) return { deleted: false }
      if (run.parentRunId !== undefined) {
        throw new Error(`Run [${runId}] is not a root run`)
      }

      const familyRunIds = collectRunDescendantIds(runId)
      for (const familyRunId of familyRunIds) {
        const familyRun = runs.get(familyRunId)
        if (familyRun && isTerminalRunStatus(familyRun.status)) continue
        throw new Error(`Run [${runId}] has non-terminal runs`)
      }

      deleteRunTrees(familyRunIds)
      return { deleted: true }
    },
    async listDeadCommands(params) {
      const dead: DeadWorkflowCommand[] = []

      for (const item of queuedCommands(state)) {
        if (
          params?.runId !== undefined &&
          item.payload.runId !== params.runId
        ) {
          continue
        }
        const command = toDeadCommand(item)
        if (command) dead.push(command)
      }

      return dead.sort((left, right) => {
        const byDeadAt = right.deadAt.getTime() - left.deadAt.getTime()
        if (byDeadAt !== 0) return byDeadAt
        const byCreatedAt = right.createdAt.getTime() - left.createdAt.getTime()
        if (byCreatedAt !== 0) return byCreatedAt
        return left.id.localeCompare(right.id)
      })
    },
    async listUnreapedDeadCommands(params) {
      const dead: DeadWorkflowCommand[] = []

      for (const item of queuedCommands(state)) {
        if (item.reapedAt !== undefined) continue
        if (params?.commandId !== undefined && item.id !== params.commandId) {
          continue
        }
        const command = toDeadCommand(item)
        if (command) dead.push(command)
      }

      dead.sort((left, right) => left.deadAt.getTime() - right.deadAt.getTime())
      return params?.limit === undefined ? dead : dead.slice(0, params.limit)
    },
    async markDeadCommandReaped(commandId) {
      for (const queue of commandQueues(state)) {
        const index = queue.findIndex(
          (item) =>
            item.id === commandId &&
            item.deadAt !== undefined &&
            item.reapedAt === undefined,
        )
        if (index === -1) continue
        queue[index] = { ...queue[index]!, reapedAt: now() }
        return
      }
    },
    async requeueDeadCommand(commandId) {
      const deadIndex = findDeadIndex(state.continueCommands, commandId)
      if (deadIndex === -1) {
        const attemptIndex = findDeadIndex(state.attemptCommands, commandId)
        if (attemptIndex === -1) return
        state.attemptCommands[attemptIndex] = revive(
          state.attemptCommands[attemptIndex]!,
        )
        return
      }

      const dead = state.continueCommands[deadIndex]!
      const requeued = revive(dead)
      const liveIndex = liveContinueIndex(state, dead.payload.runId, deadIndex)
      if (liveIndex === -1) {
        state.continueCommands[deadIndex] = requeued
        return
      }

      // Requeue is another wake-up for the run, so an existing live command
      // absorbs it without reviving a duplicate stale payload.
      state.continueCommands[liveIndex] = mergeContinue(
        state.continueCommands[liveIndex]!,
        requeued,
      )
      state.continueCommands.splice(deadIndex, 1)
    },
    async acquireRunLease({ runId, leaseMs }) {
      const at = now()
      const existing = state.runLeases.get(runId)
      if (existing && existing.expiresAt > at) return undefined

      const run = runs.get(runId)
      if (!run) return undefined

      const lease = {
        runId,
        leaseToken: newId('run-lease'),
        version: run.version,
        expiresAt: new Date(at.getTime() + leaseMs),
      }
      state.runLeases.set(runId, lease)
      return lease
    },
    async renewRunLease(lease, leaseMs) {
      const existing = state.runLeases.get(lease.runId)
      if (existing?.leaseToken !== lease.leaseToken) return undefined

      const renewed = {
        ...existing,
        expiresAt: new Date(now().getTime() + leaseMs),
      }
      state.runLeases.set(lease.runId, renewed)
      return renewed
    },
    async releaseRunLease(lease) {
      if (state.runLeases.get(lease.runId)?.leaseToken === lease.leaseToken) {
        state.runLeases.delete(lease.runId)
      }
    },
    async loadRuns(runIds) {
      const loaded: StoredRun[] = []

      for (const runId of new Set(runIds)) {
        const run = runs.get(runId)
        if (run) loaded.push(run)
      }

      return loaded
    },
    async loadRunSnapshot(runId) {
      const run = runs.get(runId)
      if (!run) return undefined

      return {
        run,
        nodes: runNodes(state, runId),
        children: runChildren(state, runId),
        attempts: runAttempts(state, runId),
      }
    },
    async loadRunDetail(runId) {
      const run = runs.get(runId)
      if (!run) return undefined

      const detailChildren = runChildren(state, runId).sort((left, right) => {
        const byNodeName = left.nodeName.localeCompare(right.nodeName)
        if (byNodeName !== 0) return byNodeName
        const byOrdinal = left.ordinal - right.ordinal
        if (byOrdinal !== 0) return byOrdinal
        return left.childKey.localeCompare(right.childKey)
      })
      const childRunIds = new Set<string>()
      for (const child of detailChildren) {
        if (child.childRunId !== undefined) childRunIds.add(child.childRunId)
      }
      const childRuns = [...runs.values()]
        .filter((childRun) => childRunIds.has(childRun.id))
        .sort(compareRunsOldest)

      return {
        run: runSummary(run),
        nodes: runNodes(state, runId).map(nodeSummary),
        children: detailChildren.map(childSummary),
        attempts: runAttempts(state, runId)
          .sort(compareAttempts)
          .map(attemptSummary),
        childRuns: childRuns.map(runSummary),
      }
    },
    async loadNodeSnapshot({ runId, nodeName }) {
      const node = nodes.get(nodeKey(runId, nodeName))
      if (!node) return undefined

      return {
        node,
        children: sortedChildren(nodeChildren(state, runId, nodeName)),
        attempts: nodeAttempts(state, runId, nodeName).sort(compareAttempts),
      }
    },
    async listRunFamily(runId) {
      const run = runs.get(runId)
      if (!run) return []

      const origins = new Map<string, NonNullable<RunFamilyEntry['origin']>>()
      for (const child of children.values()) {
        if (child.childRunId === undefined || origins.has(child.childRunId)) {
          continue
        }
        origins.set(child.childRunId, {
          nodeName: child.nodeName,
          childKey: child.childKey,
        })
      }

      const family: RunFamilyEntry[] = []
      const members = [...runs.values()]
        .filter((familyRun) => familyRun.rootRunId === run.rootRunId)
        .sort(compareRunsOldest)
      for (const member of members) {
        const origin = origins.get(member.id)
        family.push({
          run: runSummary(member),
          ...(origin === undefined ? {} : { origin }),
        })
      }

      return family
    },
    async createNode(input) {
      const key = nodeKey(input.runId, input.name)
      const existing = nodes.get(key)
      if (existing) return existing

      const at = now()
      const node: StoredNode = {
        runId: input.runId,
        name: input.name,
        kind: input.kind,
        status: 'pending',
        version: 1,
        createdAt: at,
        updatedAt: at,
      }
      nodes.set(key, node)
      return node
    },
    async setNodeInput({ runId, nodeName, input }) {
      const node = nodes.get(nodeKey(runId, nodeName))
      if (!node) throw new Error(`Missing node [${runId}.${nodeName}]`)
      if (isTerminalNodeStatus(node.status)) return node

      return writeNode(node, { input })
    },
    async selectNodeCase({ runId, nodeName, caseKey }) {
      const node = nodes.get(nodeKey(runId, nodeName))
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node
      if (node.selectedCase === caseKey) return node
      if (node.selectedCase !== undefined) {
        throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
      }

      return writeNode(node, { selectedCase: caseKey })
    },
    async createAttempt(input) {
      const child = requireChild(input)
      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${describeChild(input)}] cannot create attempt`,
        )
      }

      return createChildAttempt(child, input.input, input.idempotencyKey)
    },
    async completeCurrentAttempt({ attemptId, leaseToken, output }) {
      const fenced = fencedCurrentAttempt(attemptId, leaseToken)
      if (!fenced) return undefined

      const updated = settleAttempt(fenced.attempt, {
        status: 'completed',
        output,
      })
      writeChild(fenced.child, { status: 'completed', output })
      return updated
    },
    async failCurrentAttempt({ attemptId, leaseToken, error }) {
      const fenced = fencedCurrentAttempt(attemptId, leaseToken)
      if (!fenced) return undefined

      return settleAttempt(fenced.attempt, {
        status: 'failed',
        error: toStoredError(error),
      })
    },
    async timeoutCurrentAttempt({ attemptId, leaseToken, error }) {
      const fenced = fencedCurrentAttempt(attemptId, leaseToken)
      if (!fenced) return undefined

      return settleAttempt(fenced.attempt, {
        status: 'timedOut',
        error: toStoredError(error),
      })
    },
    async completeNode({ runId, nodeName, output }) {
      return transitionNode(runId, nodeName, { status: 'completed', output })
    },
    async failNode({ runId, nodeName, error }) {
      return transitionNode(runId, nodeName, {
        status: 'failed',
        error: toStoredError(error),
      })
    },
    async cancelNode({ runId, nodeName }) {
      return transitionNode(runId, nodeName, { status: 'cancelled' })
    },
    async waitNode({ runId, nodeName }) {
      const node = nodes.get(nodeKey(runId, nodeName))
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status) || node.status === 'waiting') {
        return node
      }

      return writeNode(node, { status: 'waiting' })
    },
    async markRunRunning({ runId }) {
      return transitionRun(runId, { status: 'running' })
    },
    async markRunWaiting({ runId }) {
      return transitionRun(runId, { status: 'waiting' })
    },
    async completeRun({ runId, output }) {
      return transitionRun(runId, { status: 'completed', output })
    },
    async failRun({ runId, error }) {
      return transitionRun(runId, {
        status: 'failed',
        error: toStoredError(error),
      })
    },
    async cancelRun({ runId }) {
      return transitionRun(runId, { status: 'cancelled' })
    },
    async requestRunCancellation({ runId }) {
      const before = runs.get(runId)
      const updated = transitionRun(runId, { status: 'cancelling' })
      if (updated && updated !== before) {
        state.fire(state.cancellationWakeListeners.get(runId))
      }
      return updated
    },
    async cancelNonTerminalRunNodes({ runId }) {
      const cancelled: StoredNode[] = []

      for (const node of runNodes(state, runId)) {
        if (isTerminalNodeStatus(node.status)) continue
        cancelled.push(writeNode(node, { status: 'cancelled' }))
      }
      for (const child of runChildren(state, runId)) {
        if (isTerminalNodeStatus(child.status)) continue
        writeChild(child, { status: 'cancelled' })
      }
      for (const attempt of runAttempts(state, runId)) {
        if (attempt.status !== 'started') continue
        settleAttempt(attempt, { status: 'cancelled' })
      }

      return cancelled
    },
    async ensureNodeChildren(params) {
      const node = nodes.get(nodeKey(params.runId, params.nodeName))
      if (!node) {
        throw new Error(`Missing node [${params.runId}.${params.nodeName}]`)
      }

      const existing = nodeChildren(state, params.runId, params.nodeName)
      if (existing.length > 0) {
        const matches =
          existing.length === params.children.length &&
          params.children.every((input) => {
            const child = children.get(
              childMapKey({ ...params, childKey: input.childKey }),
            )
            return (
              child !== undefined &&
              child.kind === input.kind &&
              child.ordinal === (input.ordinal ?? 0) &&
              child.itemKey === input.itemKey &&
              sameValue(child.item, input.item)
            )
          })
        if (!matches) {
          throw new Error(
            `Conflicting node children [${params.runId}.${params.nodeName}]`,
          )
        }
        return { children: sortedChildren(existing), created: false }
      }

      const at = now()
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
          createdAt: at,
          updatedAt: at,
        }
        children.set(childMapKey(child), child)
        return child
      })
      return { children: sortedChildren(created), created: true }
    },
    async ensureChildRun(params) {
      const child = requireChild(params)

      if (child.childRunId !== undefined) {
        const childRun = runs.get(child.childRunId)
        if (!childRun) {
          throw new Error(`Missing child run [${child.childRunId}]`)
        }
        if (
          childRun.kind !== params.childKind ||
          childRun.name !== params.childName ||
          !sameValue(childRun.input, params.input) ||
          !sameValue(childRun.idempotencyKey, params.idempotencyKey)
        ) {
          throw new Error(`Conflicting child run [${describeChild(params)}]`)
        }
        if (child.status !== 'pending') {
          return { child, childRun, created: false }
        }

        const running: StoredNodeChild = {
          ...child,
          status: 'running',
          version: child.version + 1,
          updatedAt: now(),
        }
        children.set(childMapKey(child), running)
        return { child: running, childRun, created: false }
      }

      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${describeChild(params)}] cannot start child run`,
        )
      }

      const { run: childRun } = createRun(state, {
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
      })
      const linked = writeChild(child, {
        childRunId: childRun.id,
        status: 'running',
      })
      return { child: linked, childRun, created: true }
    },
    async ensureChildAttempt(params) {
      const child = requireChild(params)

      if (child.attemptCount > 0) {
        const current = latestAttempt(state, child)
        if (!current) {
          throw new Error(
            `Missing node child attempt [${describeChild(params)}]`,
          )
        }
        if (
          child.status === 'pending' &&
          child.currentAttemptId === undefined
        ) {
          return {
            attempt: createChildAttempt(
              child,
              current.input,
              current.idempotencyKey,
            ),
            created: true,
          }
        }
        return { attempt: current, created: false }
      }

      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${describeChild(params)}] cannot create attempt`,
        )
      }

      return {
        attempt: createChildAttempt(child, params.input, params.idempotencyKey),
        created: true,
      }
    },
    async completeNodeChild({ runId, nodeName, childKey, output }) {
      return transitionChild(
        { runId, nodeName, childKey },
        { status: 'completed', output },
      )
    },
    async failNodeChild({ runId, nodeName, childKey, error }) {
      return transitionChild(
        { runId, nodeName, childKey },
        { status: 'failed', error: toStoredError(error) },
      )
    },
    async loadNodeChildren({ runId, nodeName }) {
      return {
        children: sortedChildren(nodeChildren(state, runId, nodeName)),
        attempts: nodeAttempts(state, runId, nodeName),
      }
    },
  }

  return store
}

function runnableName(input: CreateRunInput) {
  return input.name ?? input.taskName ?? input.workflowName
}

function matchesCreateInput(run: StoredRun, input: CreateRunInput) {
  return (
    run.kind === (input.kind ?? 'workflow') &&
    run.name === runnableName(input) &&
    run.workflowName === input.workflowName &&
    run.taskName === input.taskName &&
    run.parentRunId === input.parentRunId &&
    run.parentNodeName === input.parentNodeName &&
    run.rootRunId === (input.rootRunId ?? run.id) &&
    sameValue(run.input, input.input)
  )
}

function matchesFilter(run: StoredRun, filter: ListRunsFilter) {
  if (filter.kind !== undefined && run.kind !== filter.kind) return false
  if (filter.name !== undefined && run.name !== filter.name) return false
  if (filter.status !== undefined) {
    const statuses = [filter.status].flat()
    if (!statuses.includes(run.status)) return false
  }
  if (
    filter.activeBefore !== undefined &&
    run.activeSince >= filter.activeBefore
  ) {
    return false
  }
  if (
    filter.createdBefore !== undefined &&
    run.createdAt >= filter.createdBefore
  ) {
    return false
  }
  if (
    filter.parentRunId !== undefined &&
    run.parentRunId !== (filter.parentRunId ?? undefined)
  ) {
    return false
  }
  if (filter.rootRunId !== undefined && run.rootRunId !== filter.rootRunId) {
    return false
  }
  if (filter.tags !== undefined) {
    for (const [key, value] of Object.entries(filter.tags)) {
      if (run.tags[key] !== value) return false
    }
  }
  return jsonContains(run.input, filter.input)
}
