import type { WorkflowNodeKind } from '../types/index.ts'
import type {
  NodeChildIdentity,
  RunSnapshot,
  StoredAttempt,
  StoredChildLink,
  StoredMapItem,
  StoredNode,
  StoredRun,
} from './state.ts'

export type RunLease = {
  readonly runId: string
  readonly leaseToken: string
  readonly version: number
}

export type CreateRunInput = {
  readonly workflowName: string
  readonly input: unknown
  readonly parentRunId?: string
  readonly parentNodeName?: string
  readonly rootRunId?: string
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export type CreateNodeInput = {
  readonly runId: string
  readonly name: string
  readonly kind: WorkflowNodeKind
}

export type CreateAttemptInput = {
  readonly runId: string
  readonly nodeName: string
  readonly input: unknown
}

export type EnsureNodeAttemptParams = {
  readonly identity: NodeChildIdentity
  readonly kind: 'activity' | 'task'
  readonly input: unknown
}

export type EnsureNodeAttemptResult = {
  readonly attempt: StoredAttempt
  readonly created: boolean
}

export type EnsureChildWorkflowRunParams = {
  readonly identity: NodeChildIdentity
  readonly workflowName: string
  readonly input: unknown
  readonly parentRunId: string
  readonly parentNodeName: string
  readonly rootRunId: string
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export type EnsureChildWorkflowRunResult = {
  readonly childLink: StoredChildLink
  readonly childRun: StoredRun
  readonly created: boolean
}

export type EnsureMapItemsParams = {
  readonly runId: string
  readonly nodeName: string
  readonly items: readonly unknown[]
  readonly keys?: readonly string[]
}

export type EnsureMapItemsResult = {
  readonly items: readonly StoredMapItem[]
  readonly created: boolean
}

export type CompleteMapItemParams = {
  readonly runId: string
  readonly nodeName: string
  readonly itemIndex: number
  readonly itemKey?: string
  readonly output: unknown
}

export type FailMapItemParams = {
  readonly runId: string
  readonly nodeName: string
  readonly itemIndex: number
  readonly itemKey?: string
  readonly error: unknown
}

export type LoadNodeChildrenParams = {
  readonly runId: string
  readonly nodeName: string
}

export type WaitNodeParams = {
  readonly runId: string
  readonly nodeName: string
}

export type NodeChildrenSnapshot = {
  readonly attempts: readonly StoredAttempt[]
  readonly childLinks: readonly StoredChildLink[]
  readonly mapItems: readonly StoredMapItem[]
}

export type WorkflowStore = {
  createRun(input: CreateRunInput): Promise<StoredRun>
  acquireRunLease(params: {
    runId: string
    workerId: string
    leaseMs: number
  }): Promise<RunLease | undefined>
  releaseRunLease(lease: RunLease): Promise<void>
  loadRunSnapshot(runId: string): Promise<RunSnapshot | undefined>
  createNode(input: CreateNodeInput): Promise<StoredNode>
  setNodeInput(params: {
    runId: string
    nodeName: string
    input: unknown
  }): Promise<StoredNode>
  createAttempt(input: CreateAttemptInput): Promise<StoredAttempt>
  completeCurrentAttempt(params: {
    attemptId: string
    leaseToken: string
    output: unknown
  }): Promise<StoredAttempt | undefined>
  failCurrentAttempt(params: {
    attemptId: string
    leaseToken: string
    error: unknown
  }): Promise<StoredAttempt | undefined>
  completeNode(params: {
    runId: string
    nodeName: string
    output: unknown
  }): Promise<StoredNode | undefined>
  failNode(params: {
    runId: string
    nodeName: string
    error: unknown
  }): Promise<StoredNode | undefined>
  completeRun(params: {
    runId: string
    output: unknown
  }): Promise<StoredRun | undefined>
  failRun(params: {
    runId: string
    error: unknown
  }): Promise<StoredRun | undefined>
  ensureNodeAttempt?(
    params: EnsureNodeAttemptParams,
  ): Promise<EnsureNodeAttemptResult>
  ensureChildWorkflowRun?(
    params: EnsureChildWorkflowRunParams,
  ): Promise<EnsureChildWorkflowRunResult>
  ensureMapItems?(params: EnsureMapItemsParams): Promise<EnsureMapItemsResult>
  completeMapItem?(
    params: CompleteMapItemParams,
  ): Promise<StoredMapItem | undefined>
  failMapItem?(params: FailMapItemParams): Promise<StoredMapItem | undefined>
  waitNode?(params: WaitNodeParams): Promise<StoredNode | undefined>
  loadNodeChildren?(
    params: LoadNodeChildrenParams,
  ): Promise<NodeChildrenSnapshot>
}
