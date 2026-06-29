import type { WorkflowNodeKind } from '../types/index.ts'
import type {
  RuntimeAttemptStatus,
  RuntimeNodeStatus,
  RuntimeRunStatus,
} from './status.ts'

export type StoredError = {
  readonly name?: string
  readonly message: string
  readonly stack?: string
}

export type StoredRun = {
  readonly id: string
  readonly workflowName: string
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

export type StoredNode = {
  readonly runId: string
  readonly name: string
  readonly kind: WorkflowNodeKind
  readonly status: RuntimeNodeStatus
  readonly input?: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly selectedCase?: string
  readonly currentAttemptId?: string
  readonly nextAttemptAt?: Date
  readonly attemptCount: number
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type StoredAttempt = {
  readonly id: string
  readonly runId: string
  readonly nodeName: string
  readonly status: RuntimeAttemptStatus
  readonly workerId?: string
  readonly leaseToken?: string
  readonly attemptNumber: number
  readonly input: unknown
  readonly output?: unknown
  readonly error?: StoredError
  readonly dispatchedAt: Date
  readonly heartbeatAt?: Date
  readonly completedAt?: Date
}

export type StoredChildLink = {
  readonly parentRunId: string
  readonly parentNodeName: string
  readonly childRunId: string
  readonly workflowName: string
  readonly itemIndex?: number
}

export type StoredMapItem = {
  readonly runId: string
  readonly nodeName: string
  readonly index: number
  readonly key?: string
  readonly item: unknown
  readonly status: RuntimeNodeStatus
  readonly output?: unknown
  readonly error?: StoredError
  readonly childRunId?: string
  readonly attemptId?: string
}

export type StoredTimelineEvent = {
  readonly id: string
  readonly runId: string
  readonly nodeName?: string
  readonly type: string
  readonly payload?: unknown
  readonly createdAt: Date
}

export type RunSnapshot = {
  readonly run: StoredRun
  readonly nodes: readonly StoredNode[]
  readonly attempts: readonly StoredAttempt[]
  readonly childLinks: readonly StoredChildLink[]
  readonly mapItems: readonly StoredMapItem[]
}
