import type { RunKind, WorkflowNodeKind } from '../types/index.ts'
import type {
  NodeChildKind,
  RunSnapshot,
  StoredAttempt,
  StoredError,
  StoredNode,
  StoredNodeChild,
  StoredRun,
  StoredRunEvent,
} from './state.ts'
import type { RuntimeRunStatus } from './status.ts'

export type TerminalRunStatus = Extract<
  RuntimeRunStatus,
  'completed' | 'cancelled' | 'failed'
>

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

export type ListRunsFilter = {
  readonly kind?: RunKind
  readonly name?: string
  readonly status?: RuntimeRunStatus | readonly RuntimeRunStatus[]
  readonly createdBefore?: Date
  readonly parentRunId?: string | null
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

export type ListRunEventsParams = {
  readonly runId: string
  /** Match by rootRunId instead of runId — one cursor over a whole family. */
  readonly family?: boolean
  readonly afterEventId?: string
  readonly limit?: number
}

export type ListRunEventsResult = {
  readonly events: readonly StoredRunEvent[]
  readonly nextCursor?: string
}

export type RunSummary = Omit<StoredRun, 'input' | 'output'> & {
  readonly nodesTotal: number
  readonly nodesCompleted: number
}

export type ListRunSummariesResult = {
  readonly runs: readonly RunSummary[]
  readonly nextCursor?: string
}

export type NodeSummary = Omit<StoredNode, 'input' | 'output'>
export type NodeChildSummary = Omit<
  StoredNodeChild,
  'item' | 'input' | 'output'
>
export type AttemptSummary = Omit<StoredAttempt, 'input' | 'output'>

export type RunDetail = {
  readonly run: RunSummary
  readonly nodes: readonly NodeSummary[]
  readonly children: readonly NodeChildSummary[]
  readonly attempts: readonly AttemptSummary[]
  readonly childRuns: readonly RunSummary[]
}

export type NodeSnapshot = {
  readonly node: StoredNode
  readonly children: readonly StoredNodeChild[]
  readonly attempts: readonly StoredAttempt[]
}

export type RunFamilyEntry = {
  readonly run: RunSummary
  readonly origin?: { readonly nodeName: string; readonly childKey: string }
}

export type PruneTerminalRunsParams = {
  readonly olderThan: Date
  readonly statuses?: readonly TerminalRunStatus[]
  readonly batchSize?: number
}

export type PruneTerminalRunsResult = {
  readonly deleted: number
}

export type DeleteRunResult = { readonly deleted: boolean }

export type WorkflowRetentionPruner = {
  pruneTerminalRuns(
    params: PruneTerminalRunsParams,
  ): Promise<PruneTerminalRunsResult>
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

/**
 * One child record per unit of node execution. The batch is the node's full
 * child set for fan-out nodes (parallel members, map items) and a single
 * entry otherwise, so re-entry can detect a conflicting set.
 */
export type EnsureNodeChildInput = {
  readonly childKey: string
  readonly kind: NodeChildKind
  readonly ordinal?: number
  readonly itemKey?: string
  readonly item?: unknown
}

export type EnsureNodeChildrenParams = {
  readonly runId: string
  readonly nodeName: string
  readonly children: readonly EnsureNodeChildInput[]
}

export type EnsureNodeChildrenResult = {
  readonly children: readonly StoredNodeChild[]
  readonly created: boolean
}

export type EnsureChildRunParams = {
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly childKind: RunKind
  readonly childName: string
  readonly input: unknown
  readonly rootRunId: string
  readonly tags?: Readonly<Record<string, string>>
  readonly idempotencyKey?: readonly unknown[]
}

export type EnsureChildRunResult = {
  readonly child: StoredNodeChild
  readonly childRun: StoredRun
  readonly created: boolean
}

export type EnsureChildAttemptParams = {
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly input: unknown
  readonly idempotencyKey?: readonly unknown[]
}

export type EnsureChildAttemptResult = {
  readonly attempt: StoredAttempt
  readonly created: boolean
}

export type CreateAttemptInput = {
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
  readonly input: unknown
  readonly idempotencyKey?: readonly unknown[]
}

export type NodeChildRef = {
  readonly runId: string
  readonly nodeName: string
  readonly childKey: string
}

export type SelectNodeCaseParams = {
  readonly runId: string
  readonly nodeName: string
  readonly caseKey: string
}

export type LoadNodeChildrenParams = {
  readonly runId: string
  readonly nodeName: string
}

export type NodeChildrenSnapshot = {
  readonly children: readonly StoredNodeChild[]
  readonly attempts: readonly StoredAttempt[]
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

export type WorkflowStore = {
  createRun(input: CreateRunInput): Promise<StoredRun>
  listRuns(filter?: ListRunsFilter): Promise<ListRunsResult>
  listRunEvents(params: ListRunEventsParams): Promise<ListRunEventsResult>
  listRunSummaries(filter?: ListRunsFilter): Promise<ListRunSummariesResult>
  pruneTerminalRuns(
    params: PruneTerminalRunsParams,
  ): Promise<PruneTerminalRunsResult>
  /**
   * Cascade-deletes one root run and its whole terminal family.
   */
  deleteRun(runId: string): Promise<DeleteRunResult>
  listDeadCommands(params?: {
    readonly runId?: string
  }): Promise<readonly DeadWorkflowCommand[]>
  /**
   * Dead commands the reaper has not settled yet, oldest first. The reaper
   * marks each one reaped only AFTER producing its recovery outcome, so a
   * crash mid-batch re-lists the remainder instead of stranding it; the
   * recovery writes are idempotent, making duplicate processing harmless.
   */
  listUnreapedDeadCommands(params?: {
    readonly limit?: number
  }): Promise<readonly DeadWorkflowCommand[]>
  markDeadCommandReaped(id: string): Promise<void>
  requeueDeadCommand(id: string): Promise<void>
  acquireRunLease(params: {
    runId: string
    leaseMs: number
  }): Promise<RunLease | undefined>
  renewRunLease(lease: RunLease, leaseMs: number): Promise<RunLease | undefined>
  releaseRunLease(lease: RunLease): Promise<void>
  loadRunSnapshot(runId: string): Promise<RunSnapshot | undefined>
  loadRunDetail(runId: string): Promise<RunDetail | undefined>
  loadNodeSnapshot(params: {
    runId: string
    nodeName: string
  }): Promise<NodeSnapshot | undefined>
  listRunFamily(runId: string): Promise<readonly RunFamilyEntry[]>
  /**
   * Loads run rows in first-occurrence order of `runIds`; unknown ids are
   * omitted.
   */
  loadRuns(runIds: readonly string[]): Promise<readonly StoredRun[]>
  createNode(input: CreateNodeInput): Promise<StoredNode>
  setNodeInput(params: {
    runId: string
    nodeName: string
    input: unknown
  }): Promise<StoredNode>
  selectNodeCase(params: SelectNodeCaseParams): Promise<StoredNode | undefined>
  /**
   * Idempotently creates the node's child set. Re-entry with an equal set
   * returns the stored records; a differing set is a definition conflict and
   * throws.
   */
  ensureNodeChildren(
    params: EnsureNodeChildrenParams,
  ): Promise<EnsureNodeChildrenResult>
  /**
   * Creates the child run and links it to the child record in one atomic
   * step. The child record must already exist via ensureNodeChildren.
   */
  ensureChildRun(params: EnsureChildRunParams): Promise<EnsureChildRunResult>
  /**
   * Idempotently creates the child's first attempt; once the child has any
   * attempts, returns the current one instead.
   */
  ensureChildAttempt(
    params: EnsureChildAttemptParams,
  ): Promise<EnsureChildAttemptResult>
  /**
   * Creates the child's next attempt (a retry): per-child attempt_number,
   * child current-attempt fencing, child status back to running.
   */
  createAttempt(input: CreateAttemptInput): Promise<StoredAttempt>
  /**
   * Completes the attempt AND its child record atomically, fenced by the
   * child's current attempt and the attempt lease.
   */
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
  timeoutCurrentAttempt(params: {
    attemptId: string
    leaseToken: string
    error: unknown
  }): Promise<StoredAttempt | undefined>
  completeNodeChild(
    params: NodeChildRef & { output: unknown },
  ): Promise<StoredNodeChild | undefined>
  failNodeChild(
    params: NodeChildRef & { error: unknown },
  ): Promise<StoredNodeChild | undefined>
  loadNodeChildren(
    params: LoadNodeChildrenParams,
  ): Promise<NodeChildrenSnapshot>
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
  waitNode(params: WaitNodeParams): Promise<StoredNode | undefined>
  markRunRunning(params: { runId: string }): Promise<StoredRun | undefined>
  markRunWaiting(params: { runId: string }): Promise<StoredRun | undefined>
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
  /**
   * Cancels every non-terminal node AND child record of the run in one sweep.
   */
  cancelNonTerminalRunNodes(
    params: CancelNonTerminalRunNodesParams,
  ): Promise<readonly StoredNode[]>
}
