import type { RunKind, WorkflowNodeKind } from '../types/index.ts'
import type {
  RuntimeAttemptStatus,
  RuntimeNodeStatus,
  RuntimeRunStatus,
} from './status.ts'

export type StoredError = {
  readonly name?: string
  readonly message: string
  readonly stack?: string
  readonly cause?: StoredError
}

export type RunEventKind = 'run' | 'node' | 'child' | 'attempt'

export type StoredRunEvent = {
  readonly id: string
  readonly runId: string
  readonly rootRunId: string
  readonly kind: RunEventKind
  readonly status: string
  readonly nodeName?: string
  readonly childKey?: string
  readonly attemptId?: string
  readonly attemptNumber?: number
  readonly error?: StoredError
  readonly createdAt: Date
}

export type StoredRun = {
  readonly id: string
  readonly kind: RunKind
  readonly name: string
  readonly workflowName: string
  readonly taskName?: string
  readonly status: RuntimeRunStatus
  readonly input: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly parentRunId?: string
  readonly parentNodeName?: string
  readonly rootRunId: string
  readonly tags: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/**
 * A node is a pure aggregate over its children: it owns ordering, the branch
 * case decision, and the combined output, while all execution accounting
 * (attempts, retries, child runs) lives on the child records.
 */
export type StoredNode = {
  readonly runId: string
  readonly name: string
  readonly kind: WorkflowNodeKind
  readonly status: RuntimeNodeStatus
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly selectedCase?: string
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type NodeChildKind = 'activity' | 'task' | 'workflow'

/**
 * One unit of a node's execution: the implicit single child of a plain node,
 * a branch case, a parallel member, or a map item. Attempts are strictly
 * retries of one child, so retry budgets and current-attempt fencing are
 * per-child by construction.
 */
export type StoredNodeChild = {
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly kind: NodeChildKind
  readonly status: RuntimeNodeStatus
  /** Position within the node; meaningful for map items, 0 otherwise. */
  readonly ordinal: number
  readonly itemKey?: string
  readonly item?: unknown
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly childRunId?: string
  readonly currentAttemptId?: string
  readonly attemptCount: number
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type StoredAttempt = {
  readonly id: string
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly status: RuntimeAttemptStatus
  readonly workerId?: string
  readonly leaseToken?: string
  /** Per-child ordinal: retries of the same child count from 1. */
  readonly attemptNumber: number
  readonly input: unknown
  readonly idempotencyKey?: readonly unknown[]
  readonly output?: unknown
  readonly error?: StoredError
  readonly dispatchedAt: Date
  readonly heartbeatAt?: Date
  readonly completedAt?: Date
}

export type RunSnapshot = {
  readonly run: StoredRun
  readonly nodes: readonly StoredNode[]
  readonly children: readonly StoredNodeChild[]
  readonly attempts: readonly StoredAttempt[]
}
