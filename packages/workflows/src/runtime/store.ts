import type { WorkflowNodeKind } from '../types/index.ts'
import type { RunSnapshot, StoredAttempt, StoredNode, StoredRun } from './state.ts'

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
}
