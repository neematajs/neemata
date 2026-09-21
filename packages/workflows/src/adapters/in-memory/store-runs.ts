import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type {
  AttemptSummary,
  CreateRunInput,
  ListRunsFilter,
  NodeChildSummary,
  NodeSummary,
  RunDetail,
  RunFamilyEntry,
  RunSummary,
  WorkflowStore,
} from '../../runtime/store.ts'
import type { State } from './state.ts'
import { WorkflowRunConflictError } from '../../runtime/errors.ts'
import {
  compareAttempts,
  compareRunsNewest,
  compareRunsOldest,
  runSnapshot,
  sameValue,
  valueKey,
} from './records.ts'

export function releaseActiveUniqueKey(state: State, run: StoredRun) {
  const { activeUniqueRunKeys } = state

  // Terminal runs release only the active uniqueness scope, as in Postgres.
  if (run.unique?.scope !== 'active') return
  const key = valueKey(run.unique.key)
  if (activeUniqueRunKeys.get(key) === run.id) {
    activeUniqueRunKeys.delete(key)
  }
}

function jsonContains(target: unknown, expected: unknown): boolean {
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

function runMatchesFilter(run: StoredRun, filter: ListRunsFilter) {
  const statuses =
    typeof filter.status === 'string' ? [filter.status] : filter.status

  return (
    (filter.kind === undefined || run.kind === filter.kind) &&
    (filter.name === undefined || run.name === filter.name) &&
    (statuses === undefined || statuses.includes(run.status)) &&
    (filter.activeBefore === undefined ||
      run.activeSince < filter.activeBefore) &&
    (filter.createdBefore === undefined ||
      run.createdAt < filter.createdBefore) &&
    (filter.parentRunId === undefined ||
      (filter.parentRunId === null
        ? run.parentRunId === undefined
        : run.parentRunId === filter.parentRunId)) &&
    (filter.rootRunId === undefined || run.rootRunId === filter.rootRunId) &&
    (filter.tags === undefined ||
      Object.entries(filter.tags).every(
        ([key, value]) => run.tags[key] === value,
      )) &&
    (filter.input === undefined || jsonContains(run.input, filter.input))
  )
}

function runnableName(input: CreateRunInput) {
  return input.name ?? input.taskName ?? input.workflowName
}

function runMatchesCreateInput(run: StoredRun, input: CreateRunInput) {
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

function runSummary(state: State, run: StoredRun): RunSummary {
  const { nodes } = state

  const { input: omittedInput, output: omittedOutput, ...summary } = run
  void omittedInput
  void omittedOutput
  let nodesTotal = 0
  let nodesCompleted = 0
  for (const node of nodes.values()) {
    if (node.runId !== run.id) continue
    nodesTotal++
    if (node.status === 'completed') nodesCompleted++
  }
  return { ...summary, nodesTotal, nodesCompleted }
}

function nodeSummary(node: StoredNode): NodeSummary {
  const { input: omittedInput, output: omittedOutput, ...summary } = node
  void omittedInput
  void omittedOutput
  return summary
}

function childSummary(child: StoredNodeChild): NodeChildSummary {
  const {
    item: omittedItem,
    input: omittedInput,
    output: omittedOutput,
    ...summary
  } = child
  void omittedItem
  void omittedInput
  void omittedOutput
  return summary
}

function attemptSummary(attempt: StoredAttempt): AttemptSummary {
  const { input: omittedInput, output: omittedOutput, ...summary } = attempt
  void omittedInput
  void omittedOutput
  return summary
}

export function createRunWithState(
  state: State,
  input: CreateRunInput,
): { readonly run: StoredRun; readonly created: boolean } {
  const {
    id,
    now,
    runs,
    runIdempotencyKeys,
    activeUniqueRunKeys,
    allUniqueRunKeys,
    wake,
  } = state

  if (input.idempotencyKey) {
    const existingRunId = runIdempotencyKeys.get(valueKey(input.idempotencyKey))
    if (existingRunId) {
      const existing = runs.get(existingRunId)
      if (existing && runMatchesCreateInput(existing, input)) {
        return { run: existing, created: false }
      }

      throw new Error(`Conflicting idempotent run [${input.workflowName}]`)
    }
  }

  if (input.unique) {
    const uniqueKeys =
      input.unique.scope === 'all' ? allUniqueRunKeys : activeUniqueRunKeys
    const conflictingRunId = uniqueKeys.get(valueKey(input.unique.key))
    const conflicting =
      conflictingRunId === undefined ? undefined : runs.get(conflictingRunId)
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
    ...(input.unique === undefined ? {} : { unique: input.unique }),
    version: 1,
    activeSince: date,
    createdAt: date,
    updatedAt: date,
  }
  runs.set(run.id, run)
  if (input.idempotencyKey) {
    runIdempotencyKeys.set(valueKey(input.idempotencyKey), run.id)
  }
  if (input.unique) {
    const uniqueKeys =
      input.unique.scope === 'all' ? allUniqueRunKeys : activeUniqueRunKeys
    uniqueKeys.set(valueKey(input.unique.key), run.id)
  }
  wake.runStatus(run)
  return { run, created: true }
}

type RunStore = Pick<
  WorkflowStore,
  | 'createRun'
  | 'listRuns'
  | 'listRunSummaries'
  | 'acquireRunLease'
  | 'renewRunLease'
  | 'releaseRunLease'
  | 'loadRuns'
  | 'loadRunSnapshot'
  | 'loadRunDetail'
  | 'listRunFamily'
>

export function createRunStore(state: State): RunStore {
  const { id, now, runs, nodes, attempts, children, runLeases } = state

  const store: RunStore = {
    async createRun(input: CreateRunInput) {
      return createRunWithState(state, input).run
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
        .sort(compareRunsNewest)

      const page = filtered.slice(offset, offset + limit)
      const nextOffset = offset + page.length
      return {
        runs: page,
        ...(nextOffset < filtered.length
          ? { nextCursor: String(nextOffset) }
          : {}),
      }
    },

    async listRunSummaries(filter: ListRunsFilter = {}) {
      const result = await store.listRuns(filter)
      const runs = result.runs.map((run) => runSummary(state, run))
      const { nextCursor } = result

      return {
        runs,
        ...(nextCursor === undefined ? {} : { nextCursor }),
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
        expiresAt: date + leaseMs,
      }
      runLeases.set(runId, lease)
      return lease
    },

    async renewRunLease(lease, leaseMs) {
      const existingLease = runLeases.get(lease.runId)
      if (existingLease?.leaseToken !== lease.leaseToken) return undefined
      const renewedLease = {
        ...existingLease,
        expiresAt: now() + leaseMs,
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
      const loaded = new Map<string, StoredRun>()
      for (const runId of runIds) {
        const run = runs.get(runId)
        if (run) loaded.set(runId, run)
      }
      return Array.from(loaded.values())
    },

    async loadRunSnapshot(runId) {
      const run = runs.get(runId)
      if (!run) return undefined

      return runSnapshot(state, run)
    },

    async loadRunDetail(runId) {
      const run = runs.get(runId)
      if (!run) return undefined

      const detailChildren = [...children.values()]
        .filter((child) => child.runId === runId)
        .sort((left, right) => {
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

      const summary = runSummary(state, run)
      const nodeSummaries = [...nodes.values()]
        .filter((node) => node.runId === runId)
        .map(nodeSummary)
      const childSummaries = detailChildren.map(childSummary)
      const attemptSummaries = [...attempts.values()]
        .filter((attempt) => attempt.runId === runId)
        .sort(compareAttempts)
        .map(attemptSummary)
      const childRuns = [...runs.values()]
        .filter((childRun) => childRunIds.has(childRun.id))
        .sort(compareRunsOldest)
        .map((run) => runSummary(state, run))

      return {
        run: summary,
        nodes: nodeSummaries,
        children: childSummaries,
        attempts: attemptSummaries,
        childRuns,
      } satisfies RunDetail
    },

    async listRunFamily(runId) {
      const run = runs.get(runId)
      if (!run) return []

      const origins = new Map<
        string,
        { readonly nodeName: string; readonly childKey: string }
      >()
      for (const child of children.values()) {
        if (child.childRunId !== undefined && !origins.has(child.childRunId)) {
          origins.set(child.childRunId, {
            nodeName: child.nodeName,
            childKey: child.childKey,
          })
        }
      }
      return [...runs.values()]
        .filter((familyRun) => familyRun.rootRunId === run.rootRunId)
        .sort(compareRunsOldest)
        .map((familyRun): RunFamilyEntry => {
          const run = runSummary(state, familyRun)
          const origin = origins.get(familyRun.id)

          return { run, ...(origin === undefined ? {} : { origin }) }
        })
    },
  }
  return store
}
