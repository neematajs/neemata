export const RELEASE_BACKOFF_MS = 50
export const UNROUTABLE_BACKOFF_MS = 1_000
export const MAX_ERROR_BACKOFF_MS = 300_000
export const DEFAULT_MAX_DELIVERIES = 20

// LISTEN/NOTIFY wake-up hint channels; payloads are the command kind and the
// run id respectively. Delivery is best-effort — polling remains the fallback.
export const WORKFLOW_COMMANDS_CHANNEL = 'workflow_commands'
export const WORKFLOW_CANCELLATIONS_CHANNEL = 'workflow_run_cancellations'
export const WORKFLOW_RUN_EVENTS_CHANNEL = 'workflow_run_events'
