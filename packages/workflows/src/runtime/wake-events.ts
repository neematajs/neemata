export type WorkflowCommandWakeKind = 'continue' | 'activity' | 'task'

/**
 * Optional adapter port for push-style wake-up hints layered over polling.
 * Notifications are fire-and-forget: a missed event only costs one poll
 * interval (or heartbeat cycle), never correctness — every consumer
 * re-checks durable state before acting.
 */
export type WorkflowWakeEvents = {
  /** Fires when a command of the given kind may be claimable. */
  onCommand(kind: WorkflowCommandWakeKind, listener: () => void): () => void
  /** Fires when cancellation has been requested for the given run. */
  onCancellation(runId: string, listener: () => void): () => void
  /** Fires when new run events may exist for the given root run. */
  onRunEvent?(rootRunId: string, listener: () => void): () => void
  dispose?(): Promise<void> | void
}
