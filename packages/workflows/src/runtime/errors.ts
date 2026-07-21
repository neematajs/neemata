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
