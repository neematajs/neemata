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

/** Statuses a run never leaves; also the set retention pruning deletes. */
export const TERMINAL_RUN_STATUSES = [
  'completed',
  'cancelled',
  'failed',
] as const satisfies readonly RuntimeRunStatus[]

export const TERMINAL_NODE_STATUSES = [
  'completed',
  'cancelled',
  'failed',
] as const satisfies readonly RuntimeNodeStatus[]

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number]
export type TerminalNodeStatus = (typeof TERMINAL_NODE_STATUSES)[number]

const terminalRunStatuses = new Set<RuntimeRunStatus>(TERMINAL_RUN_STATUSES)
const terminalNodeStatuses = new Set<RuntimeNodeStatus>(TERMINAL_NODE_STATUSES)

export function isTerminalRunStatus(
  status: RuntimeRunStatus,
): status is TerminalRunStatus {
  return terminalRunStatuses.has(status)
}

export function isTerminalNodeStatus(
  status: RuntimeNodeStatus,
): status is TerminalNodeStatus {
  return terminalNodeStatuses.has(status)
}
