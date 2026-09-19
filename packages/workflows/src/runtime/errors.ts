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
 * The command was acked with a lease token the queue no longer holds: another
 * worker took the delivery over, so this worker's outcome must be dropped.
 */
export class StaleAckError extends Error {
  constructor() {
    super('Stale workflow command ack')
    this.name = 'StaleAckError'
  }
}

/** The attempt's claim lease was lost while the handler was still running. */
export class AttemptLeaseLostError extends Error {
  constructor() {
    super('Workflow attempt heartbeat lease lost')
    this.name = 'AttemptLeaseLostError'
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

export function toStoredError(error: unknown): StoredError {
  return serializeError(error, {
    depth: MAX_STORED_ERROR_CAUSE_DEPTH,
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
