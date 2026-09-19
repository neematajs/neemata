import type { RunUniqueScope } from '../../types/index.ts'
import type {
  StoredAttempt,
  StoredError,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../state.ts'
import type { RuntimeNodeStatus, RuntimeRunStatus } from '../status.ts'
import type { CreateRunInput, NodeChildRef } from '../store.ts'
import type { State } from './state.ts'
import { WorkflowRunConflictError } from '../errors.ts'
import { sameValue, valueKey } from '../json.ts'
import { isTerminalNodeStatus, isTerminalRunStatus } from '../status.ts'
import {
  NODE_TRANSITIONS,
  RUN_TRANSITIONS,
  canTransition,
} from '../transitions.ts'
import { childMapKey, describeChild, nodeKey } from './state.ts'

export type RunPatch = {
  readonly status: RuntimeRunStatus
  readonly output?: unknown
  readonly error?: StoredError
}

export type NodePatch = {
  readonly status?: RuntimeNodeStatus
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly selectedCase?: string
}

export type ChildPatch = {
  readonly status?: RuntimeNodeStatus
  readonly output?: unknown
  readonly error?: StoredError
  readonly childRunId?: string
  readonly currentAttemptId?: string
  readonly attemptCount?: number
}

export type AttemptPatch = {
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
    const conflictingId = uniqueKeys(state, input.unique.scope).get(
      valueKey(input.unique.key),
    )
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
    uniqueKeys(state, input.unique.scope).set(
      valueKey(input.unique.key),
      run.id,
    )
  }
  state.emitRunEvent(run)

  return { run, created: true }
}

export function uniqueKeys(state: State, scope: RunUniqueScope) {
  return scope === 'all' ? state.allUniqueRunKeys : state.activeUniqueRunKeys
}

export function transitionRun(state: State, runId: string, patch: RunPatch) {
  const run = state.runs.get(runId)
  if (!run) return undefined
  if (!canTransition(RUN_TRANSITIONS, run.status, patch.status)) return run

  const updated: StoredRun = {
    ...run,
    ...patch,
    version: run.version + 1,
    updatedAt: state.now(),
  }
  state.runs.set(runId, updated)
  // mirrors the partial index predicate: a terminal run leaves the active
  // uniqueness scope and frees its key
  if (
    isTerminalRunStatus(updated.status) &&
    updated.unique?.scope === 'active'
  ) {
    const key = valueKey(updated.unique.key)
    if (state.activeUniqueRunKeys.get(key) === updated.id) {
      state.activeUniqueRunKeys.delete(key)
    }
  }
  state.emitRunEvent(updated)
  return updated
}

export function writeNode(state: State, node: StoredNode, patch: NodePatch) {
  const updated: StoredNode = {
    ...node,
    ...patch,
    version: node.version + 1,
    updatedAt: state.now(),
  }
  state.nodes.set(nodeKey(node.runId, node.name), updated)
  state.emitStatusChange(node, updated)
  return updated
}

export function transitionNode(
  state: State,
  runId: string,
  nodeName: string,
  patch: NodePatch & { readonly status: RuntimeNodeStatus },
) {
  const node = state.nodes.get(nodeKey(runId, nodeName))
  if (!node) return undefined
  if (!canTransition(NODE_TRANSITIONS, node.status, patch.status)) return node

  return writeNode(state, node, patch)
}

export function writeChild(
  state: State,
  child: StoredNodeChild,
  patch: ChildPatch,
) {
  const updated: StoredNodeChild = {
    ...child,
    ...patch,
    version: child.version + 1,
    updatedAt: state.now(),
  }
  state.children.set(childMapKey(child), updated)
  state.emitStatusChange(child, updated)
  return updated
}

export function transitionChild(
  state: State,
  ref: NodeChildRef,
  patch: ChildPatch & { readonly status: RuntimeNodeStatus },
) {
  const child = state.children.get(childMapKey(ref))
  if (!child) return undefined
  if (!canTransition(NODE_TRANSITIONS, child.status, patch.status)) return child

  return writeChild(state, child, patch)
}

export function requireChild(state: State, ref: NodeChildRef) {
  const child = state.children.get(childMapKey(ref))
  if (!child) {
    throw new Error(`Missing node child [${describeChild(ref)}]`)
  }
  return child
}

export function settleAttempt(
  state: State,
  attempt: StoredAttempt,
  patch: AttemptPatch,
) {
  const updated: StoredAttempt = {
    ...attempt,
    ...patch,
    completedAt: state.now(),
  }
  state.attempts.set(attempt.id, updated)
  state.emitStatusChange(attempt, updated)
  return updated
}

export function createChildAttempt(
  state: State,
  child: StoredNodeChild,
  input: unknown,
  idempotencyKey: readonly unknown[] | undefined,
): StoredAttempt {
  const previous =
    child.currentAttemptId === undefined
      ? undefined
      : state.attempts.get(child.currentAttemptId)
  const attempt: StoredAttempt = {
    id: state.newId('attempt'),
    runId: child.runId,
    nodeName: child.nodeName,
    childKey: child.childKey,
    status: 'started',
    leaseToken: state.newId('attempt-lease'),
    attemptNumber: child.attemptCount + 1,
    retryAttemptNumber: (previous?.retryAttemptNumber ?? 0) + 1,
    input,
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    dispatchedAt: state.now(),
  }
  state.attempts.set(attempt.id, attempt)
  state.emitStatusChange(undefined, attempt)
  writeChild(state, child, {
    status: 'running',
    currentAttemptId: attempt.id,
    attemptCount: child.attemptCount + 1,
  })

  // Aggregate hint only: the node mirrors "some child is executing" so
  // observers see progress without deriving it from child rows.
  const node = state.nodes.get(nodeKey(child.runId, child.nodeName))
  // Self-inclusive like the postgres guard, so version bumps stay in
  // lockstep across adapters even when the node is already running.
  if (
    node &&
    (node.status === 'running' ||
      canTransition(NODE_TRANSITIONS, node.status, 'running'))
  ) {
    writeNode(state, node, { status: 'running' })
  }

  return attempt
}

/** The attempt is writable only while it holds the child's current lease. */
export function fencedCurrentAttempt(
  state: State,
  attemptId: string,
  leaseToken: string,
) {
  const attempt = state.attempts.get(attemptId)
  if (!attempt || attempt.leaseToken !== leaseToken) return undefined
  if (attempt.status !== 'started') return undefined

  const child = state.children.get(childMapKey(attempt))
  if (
    !child ||
    isTerminalNodeStatus(child.status) ||
    child.currentAttemptId !== attemptId
  ) {
    return undefined
  }
  return { attempt, child }
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
