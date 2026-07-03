import type { RunKind, WorkflowNodeKind } from '../types/index.ts'
import type {
  NodeChildIdentity,
  RunSnapshot,
  StoredAttempt,
  StoredChildLink,
  StoredError,
  StoredMapItem,
  StoredNode,
  StoredRun,
} from './state.ts'
import type { RuntimeRunStatus } from './status.ts'

export type RunLease = {
  readonly runId: string
  readonly leaseToken: string
  readonly version: number
}

export type CreateRunInput = {
  readonly kind?: RunKind
  readonly name?: string
  readonly workflowName: string
  readonly taskName?: string
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
  readonly idempotencyKey?: readonly unknown[]
}

export type ListRunsFilter = {
  readonly kind?: RunKind
  readonly name?: string
  readonly status?: RuntimeRunStatus | readonly RuntimeRunStatus[]
  readonly parentRunId?: string
  readonly rootRunId?: string
  readonly tags?: Readonly<Record<string, string>>
  readonly input?: unknown
  readonly limit?: number
  readonly cursor?: string
}

export type ListRunsResult = {
  readonly runs: readonly StoredRun[]
  readonly nextCursor?: string
}

export type DeadWorkflowCommand = {
  readonly id: string
  readonly kind: 'continue' | 'activity' | 'task'
  readonly runId: string
  readonly workflowName?: string
  readonly taskName?: string
  readonly activityName?: string
  readonly nodeName?: string
  readonly attemptId?: string
  readonly payload: unknown
  readonly deliveryCount: number
  readonly lastError?: StoredError
  readonly deadAt: Date
  readonly createdAt: Date
}

export type EnsureNodeAttemptParams = {
  readonly identity: NodeChildIdentity
  readonly kind: 'activity' | 'task'
  readonly input: unknown
  readonly idempotencyKey?: readonly unknown[]
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

export type EnsureChildRunParams = {
  readonly identity: NodeChildIdentity
  readonly childKind: RunKind
  readonly childName: string
  readonly input: unknown
  readonly parentRunId: string
  readonly parentNodeName: string
  readonly rootRunId: string
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export type EnsureChildRunResult = {
  readonly childLink: StoredChildLink
  readonly childRun: StoredRun
  readonly created: boolean
}

export type EnsureMapItemsParams = {
  readonly runId: string
  readonly nodeName: string
  readonly items: readonly unknown[]
  readonly keys?: readonly (string | undefined)[]
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

export type SelectNodeCaseParams = {
  readonly runId: string
  readonly nodeName: string
  readonly caseKey: string
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

export type RequestRunCancellationParams = {
  readonly runId: string
}

export type CancelNodeParams = {
  readonly runId: string
  readonly nodeName: string
}

export type CancelNonTerminalRunNodesParams = {
  readonly runId: string
}

export type NodeChildrenSnapshot = {
  readonly attempts: readonly StoredAttempt[]
  readonly childLinks: readonly StoredChildLink[]
  readonly mapItems: readonly StoredMapItem[]
}

export type WorkflowStore = {
  createRun(input: CreateRunInput): Promise<StoredRun>
  listRuns(filter?: ListRunsFilter): Promise<ListRunsResult>
  listDeadCommands(): Promise<readonly DeadWorkflowCommand[]>
  requeueDeadCommand(id: string): Promise<void>
  acquireRunLease(params: {
    runId: string
    leaseMs: number
  }): Promise<RunLease | undefined>
  renewRunLease(lease: RunLease, leaseMs: number): Promise<RunLease | undefined>
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
  requestRunCancellation(
    params: RequestRunCancellationParams,
  ): Promise<StoredRun | undefined>
  cancelRun(params: { runId: string }): Promise<StoredRun | undefined>
  cancelNode(params: CancelNodeParams): Promise<StoredNode | undefined>
  cancelNonTerminalRunNodes(
    params: CancelNonTerminalRunNodesParams,
  ): Promise<readonly StoredNode[]>
  ensureNodeAttempt(
    params: EnsureNodeAttemptParams,
  ): Promise<EnsureNodeAttemptResult>
  ensureChildWorkflowRun(
    params: EnsureChildWorkflowRunParams,
  ): Promise<EnsureChildWorkflowRunResult>
  ensureChildRun(params: EnsureChildRunParams): Promise<EnsureChildRunResult>
  selectNodeCase(params: SelectNodeCaseParams): Promise<StoredNode | undefined>
  ensureMapItems(params: EnsureMapItemsParams): Promise<EnsureMapItemsResult>
  completeMapItem(
    params: CompleteMapItemParams,
  ): Promise<StoredMapItem | undefined>
  failMapItem(params: FailMapItemParams): Promise<StoredMapItem | undefined>
  waitNode(params: WaitNodeParams): Promise<StoredNode | undefined>
  loadNodeChildren(
    params: LoadNodeChildrenParams,
  ): Promise<NodeChildrenSnapshot>
}
