import type { WorkflowStatus } from '../types/index.ts'

export type RuntimeRunStatus = WorkflowStatus

export type RuntimeNodeStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'

export type RuntimeAttemptStatus =
  | 'started'
  | 'completed'
  | 'failed'
  | 'timedOut'
  | 'cancelled'

export function isTerminalRunStatus(status: RuntimeRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function isTerminalNodeStatus(status: RuntimeNodeStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}
