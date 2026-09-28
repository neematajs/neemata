import { serializeError } from '@nmtjs/common'

import type { RunUniqueScope } from '../types/index.ts'
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

  constructor(details: {
    readonly runId: string
    readonly status: RuntimeRunStatus
    readonly key: readonly unknown[]
    readonly scope: RunUniqueScope
  }) {
    super(
      `Run [${details.runId}] already holds unique key [scope: ${details.scope}]`,
    )
    this.name = 'WorkflowRunConflictError'
    this.runId = details.runId
    this.status = details.status
    this.key = details.key
    this.scope = details.scope
  }
}

/**
 * A start reused an `idempotencyKey` already held by a run that was started
 * with a different input or for a different target. Idempotency keys only
 * dedupe retries of the same request; `unique` with `behavior: 'join'` is the
 * tool for "at most one run per key" when inputs may differ.
 */
export class WorkflowIdempotencyConflictError extends Error {
  /** The run that already holds the key. */
  readonly runId: string
  readonly status: RuntimeRunStatus
  readonly key: readonly unknown[]
  /** The workflow or task the rejected start targeted. */
  readonly runnableName: string

  constructor(details: {
    readonly runId: string
    readonly status: RuntimeRunStatus
    readonly key: readonly unknown[]
    readonly runnableName: string
  }) {
    super(
      `Run [${details.runId}] already holds idempotency key for a different start [${details.runnableName}]`,
    )
    this.name = 'WorkflowIdempotencyConflictError'
    this.runId = details.runId
    this.status = details.status
    this.key = details.key
    this.runnableName = details.runnableName
  }
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
