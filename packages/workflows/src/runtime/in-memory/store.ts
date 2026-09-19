import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../state.ts'
import type {
  AttemptSummary,
  DeadWorkflowCommand,
  ListRunsFilter,
  NodeChildSummary,
  NodeSummary,
  RunFamilyEntry,
  RunSummary,
  WorkflowStore,
} from '../store.ts'
import type { State } from './state.ts'
import { toStoredError } from '../errors.ts'
import { jsonContains, sameValue } from '../json.ts'
import { normalizeBatchSize, normalizePruneStatuses } from '../limits.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from '../status.ts'
import { ATTEMPT_TRANSITIONS, canTransition } from '../transitions.ts'
import {
  commandQueues,
  findDeadIndex,
  liveContinueIndex,
  mergeContinue,
  queuedCommands,
  removeWhere,
  revive,
  toDeadCommand,
} from './queue.ts'
import {
  createChildAttempt,
  createRun,
  fencedCurrentAttempt,
  requireChild,
  settleAttempt,
  transitionChild,
  transitionNode,
  transitionRun,
  writeChild,
  writeNode,
} from './records.ts'
import { reopenFailedRun } from './retry.ts'
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

export function createStore(state: State): WorkflowStore {
  const { runs, nodes, children, attempts, now, newId } = state

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
      return reopenFailedRun(state, params)
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

      return writeNode(state, node, { input })
    },
    async selectNodeCase({ runId, nodeName, caseKey }) {
      const node = nodes.get(nodeKey(runId, nodeName))
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status)) return node
      if (node.selectedCase === caseKey) return node
      if (node.selectedCase !== undefined) {
        throw new Error(`Conflicting selected case for [${runId}.${nodeName}]`)
      }

      return writeNode(state, node, { selectedCase: caseKey })
    },
    async createAttempt(input) {
      const child = requireChild(state, input)
      if (isTerminalNodeStatus(child.status)) {
        throw new Error(
          `Terminal node child [${describeChild(input)}] cannot create attempt`,
        )
      }

      return createChildAttempt(state, child, input.input, input.idempotencyKey)
    },
    async completeCurrentAttempt({ attemptId, leaseToken, output }) {
      const fenced = fencedCurrentAttempt(state, attemptId, leaseToken)
      if (!fenced) return undefined

      const updated = settleAttempt(state, fenced.attempt, {
        status: 'completed',
        output,
      })
      writeChild(state, fenced.child, { status: 'completed', output })
      return updated
    },
    async failCurrentAttempt({ attemptId, leaseToken, error }) {
      const fenced = fencedCurrentAttempt(state, attemptId, leaseToken)
      if (!fenced) return undefined

      return settleAttempt(state, fenced.attempt, {
        status: 'failed',
        error: toStoredError(error),
      })
    },
    async timeoutCurrentAttempt({ attemptId, leaseToken, error }) {
      const fenced = fencedCurrentAttempt(state, attemptId, leaseToken)
      if (!fenced) return undefined

      return settleAttempt(state, fenced.attempt, {
        status: 'timedOut',
        error: toStoredError(error),
      })
    },
    async completeNode({ runId, nodeName, output }) {
      return transitionNode(state, runId, nodeName, {
        status: 'completed',
        output,
      })
    },
    async failNode({ runId, nodeName, error }) {
      return transitionNode(state, runId, nodeName, {
        status: 'failed',
        error: toStoredError(error),
      })
    },
    async cancelNode({ runId, nodeName }) {
      return transitionNode(state, runId, nodeName, { status: 'cancelled' })
    },
    async waitNode({ runId, nodeName }) {
      const node = nodes.get(nodeKey(runId, nodeName))
      if (!node) return undefined
      if (isTerminalNodeStatus(node.status) || node.status === 'waiting') {
        return node
      }

      return writeNode(state, node, { status: 'waiting' })
    },
    async markRunRunning({ runId }) {
      return transitionRun(state, runId, { status: 'running' })
    },
    async markRunWaiting({ runId }) {
      return transitionRun(state, runId, { status: 'waiting' })
    },
    async completeRun({ runId, output }) {
      return transitionRun(state, runId, { status: 'completed', output })
    },
    async failRun({ runId, error }) {
      return transitionRun(state, runId, {
        status: 'failed',
        error: toStoredError(error),
      })
    },
    async cancelRun({ runId }) {
      return transitionRun(state, runId, { status: 'cancelled' })
    },
    async requestRunCancellation({ runId }) {
      const before = runs.get(runId)
      const updated = transitionRun(state, runId, { status: 'cancelling' })
      if (updated && updated !== before) {
        state.fire(state.cancellationWakeListeners.get(runId))
      }
      return updated
    },
    async cancelNonTerminalRunNodes({ runId }) {
      const cancelled: StoredNode[] = []

      for (const node of runNodes(state, runId)) {
        if (isTerminalNodeStatus(node.status)) continue
        cancelled.push(writeNode(state, node, { status: 'cancelled' }))
      }
      for (const child of runChildren(state, runId)) {
        if (isTerminalNodeStatus(child.status)) continue
        writeChild(state, child, { status: 'cancelled' })
      }
      for (const attempt of runAttempts(state, runId)) {
        if (!canTransition(ATTEMPT_TRANSITIONS, attempt.status, 'cancelled')) {
          continue
        }
        settleAttempt(state, attempt, { status: 'cancelled' })
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
      const child = requireChild(state, params)

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
      const linked = writeChild(state, child, {
        childRunId: childRun.id,
        status: 'running',
      })
      return { child: linked, childRun, created: true }
    },
    async ensureChildAttempt(params) {
      const child = requireChild(state, params)

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
              state,
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
        attempt: createChildAttempt(
          state,
          child,
          params.input,
          params.idempotencyKey,
        ),
        created: true,
      }
    },
    async completeNodeChild({ runId, nodeName, childKey, output }) {
      return transitionChild(
        state,
        { runId, nodeName, childKey },
        { status: 'completed', output },
      )
    },
    async failNodeChild({ runId, nodeName, childKey, error }) {
      return transitionChild(
        state,
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
