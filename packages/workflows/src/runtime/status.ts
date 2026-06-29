export type RuntimeRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'completed'

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
