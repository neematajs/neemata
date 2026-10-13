import { serializeError } from '@nmtjs/common'

import type { RunnableRef, RunUniqueScope } from '../types/index.ts'
import type { StoredError } from './state.ts'
import type { RuntimeRunStatus } from './status.ts'

/**
 * A start was rejected by a `unique` constraint (`behavior: 'reject'`).
 * Carries the conflicting run so callers can surface "already in progress"
 * without a follow-up query.
 */
export class WorkflowRunConflictError extends Error {
  readonly runId: string
  readonly status: RuntimeRunStatus
  readonly key: readonly unknown[]
  readonly scope: RunUniqueScope
  /**
   * Set when a `join` was refused because the run holding the key is another
   * workflow, task or revision than the one requested: joining would hand the
   * caller a run typed by a contract it was not created with.
   */
  readonly holder?: RunnableRef

  constructor(details: {
    readonly runId: string
    readonly status: RuntimeRunStatus
    readonly key: readonly unknown[]
    readonly scope: RunUniqueScope
    readonly holder?: RunnableRef
  }) {
    const { holder } = details
    super(
      holder === undefined
        ? `Run [${details.runId}] already holds unique key [scope: ${details.scope}]`
        : `Run [${details.runId}] of ${formatRunnableRef(holder)} already holds unique key [scope: ${details.scope}] and cannot be joined as another workflow, task or revision`,
    )
    this.name = 'WorkflowRunConflictError'
    this.runId = details.runId
    this.status = details.status
    this.key = details.key
    this.scope = details.scope
    if (holder !== undefined) this.holder = holder
  }
}

/**
 * A start reused an idempotency key that already belongs to a run with a
 * different target or input, so the key cannot return that run.
 */
export class WorkflowIdempotencyConflictError extends Error {
  readonly workflowName: string
  /** The run that owns the key, whenever the store found one. */
  readonly runId?: string

  constructor(workflowName: string, runId?: string) {
    super(`Conflicting idempotent run [${workflowName}]`)
    this.name = 'WorkflowIdempotencyConflictError'
    this.workflowName = workflowName
    if (runId !== undefined) this.runId = runId
  }
}

/**
 * A definition does not match what is saved for it: a revision whose graph or
 * child bindings differ from its stored manifest, or a graph record whose
 * content differs from its hash. A revision is immutable once saved, so the
 * changed definition needs a new revision.
 */
export class WorkflowDefinitionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowDefinitionConflictError'
  }
}

/** `workflow [name@revision]`, or `workflow [name]` for the unversioned lane. */
export function formatRunnableRef({ kind, name, revision }: RunnableRef) {
  return revision === undefined
    ? `${kind} [${name}]`
    : `${kind} [${name}@${revision}]`
}

/**
 * A write carried a `WriteFence` that no longer holds: its issuer lost the run
 * lease or the attempt it acted for, and the store wrote nothing.
 */
export class StaleWriteFenceError extends Error {
  constructor() {
    super('Stale workflow write fence')
    this.name = 'StaleWriteFenceError'
  }
}

/**
 * Recorded as `last_error` when a claim takes over an expired lease and no
 * real error is stored yet. The dying worker persisted nothing, so this
 * synthetic error is the only trace of WHY the delivery is being counted.
 * A pre-serialized constant without a stack: capturing one would point at
 * the claiming worker, not the crash, and would misdirect an incident.
 */
export const COMMAND_LEASE_EXPIRED_ERROR: StoredError = {
  name: 'Error',
  message:
    'Workflow command lease expired without release — the worker likely crashed mid-delivery',
}

const MAX_STORED_ERROR_CAUSE_DEPTH = 5

export function toStoredError(
  error: unknown,
  depth = MAX_STORED_ERROR_CAUSE_DEPTH,
): StoredError {
  return serializeError(error, {
    depth,
    omitUndefinedStack: true,
    fallback: (value) =>
      isStoredError(value) ? value : { message: String(value) },
  })
}

function isStoredError(error: unknown): error is StoredError {
  if (!error || typeof error !== 'object') return false
  if (!('message' in error) || typeof error.message !== 'string') return false

  const candidate = error as Partial<StoredError>
  return (
    (candidate.name === undefined || typeof candidate.name === 'string') &&
    (candidate.stack === undefined || typeof candidate.stack === 'string') &&
    (candidate.cause === undefined || isStoredError(candidate.cause))
  )
}
