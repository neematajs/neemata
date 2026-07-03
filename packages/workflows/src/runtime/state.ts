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

export type NodeChildIdentity = {
  readonly runId: string
  readonly nodeName: string
  readonly caseKey?: string
  readonly memberKey?: string
  readonly itemIndex?: number
  readonly itemKey?: string
}

export type StoredAttempt = {
  readonly id: string
  readonly runId: string
  readonly nodeName: string
  readonly identity?: NodeChildIdentity
  readonly status: RuntimeAttemptStatus
  readonly workerId?: string
  readonly leaseToken?: string
  readonly attemptNumber: number
  readonly input: unknown
  readonly idempotencyKey?: readonly unknown[]
  readonly output?: unknown
  readonly error?: StoredError
  readonly dispatchedAt: Date
  readonly heartbeatAt?: Date
  readonly completedAt?: Date
}

export type StoredChildLink = {
  readonly identity: NodeChildIdentity
  readonly parentRunId: string
  readonly parentNodeName: string
  readonly childRunId: string
  readonly childKind: RunKind
  readonly childName: string
  readonly workflowName: string
  readonly taskName?: string
  readonly caseKey?: string
  readonly memberKey?: string
  readonly itemIndex?: number
  readonly itemKey?: string
}

export type StoredMapItem = {
  readonly identity: NodeChildIdentity
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

export type RunSnapshot = {
  readonly run: StoredRun
  readonly nodes: readonly StoredNode[]
  readonly attempts: readonly StoredAttempt[]
  readonly childLinks: readonly StoredChildLink[]
  readonly mapItems: readonly StoredMapItem[]
}
