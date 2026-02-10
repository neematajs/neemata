import type { WorkerType } from '../enums.ts'

/**
 * Context provided to error policy decisions about worker failures.
 */
export interface WorkerErrorContext {
  workerId: string
  workerType: WorkerType
  consecutiveFailures: number
  totalFailures: number
  lastStableTime: number | null
}

/**
 * Actions that can be taken in response to errors.
 */
export type ErrorAction =
  | { type: 'exit'; code: number }
  | { type: 'restart'; delay: number }
  | { type: 'wait' } // Dev only: wait for HMR fix
  | { type: 'ignore' }

/**
 * Interface defining error handling behavior for different environments.
 * Dev and Prod modes have different requirements and this interface makes those explicit.
 */
export interface ErrorPolicy {
  /** How to handle server startup failure */
  onStartupError(error: Error): ErrorAction

  /** How to handle worker crash */
  onWorkerError(error: Error, context: WorkerErrorContext): ErrorAction

  /** Delay before restarting a failed worker */
  getRestartDelay(consecutiveFailures: number): number

  /** Whether to continue if some workers are down */
  readonly allowDegradedMode: boolean
}

/**
 * Calculates exponential backoff delay with a cap.
 * @param failures - Number of consecutive failures
 * @param base - Base delay in ms (default: 100)
 * @param maxDelay - Maximum delay in ms (default: 5000)
 */
function exponentialBackoff(
  failures: number,
  base = 100,
  maxDelay = 5000,
): number {
  return Math.min(base * 2 ** Math.max(0, failures - 1), maxDelay)
}

/**
 * Time window in ms after which a worker is considered "stable".
 * If stable, consecutive failure count is reset on next error.
 */
const STABILITY_WINDOW_MS = 30_000

/**
 * Maximum retries before giving up in dev mode.
 */
const DEV_MAX_RETRIES = 1

/**
 * Maximum retries before exiting in prod mode.
 */
const PROD_MAX_RETRIES = 3

/**
 * Development Error Policy
 *
 * - Startup errors: Wait for HMR fix (don't exit)
 * - Worker errors: Restart with exponential backoff
 * - After 10 consecutive failures: Stop retrying, wait for HMR fix
 * - Stability window: Reset failure count if worker was stable for 30s+
 * - Degraded mode: Allowed (keep serving with partial workers)
 */
export const DevErrorPolicy: ErrorPolicy = {
  onStartupError: () => ({ type: 'wait' }),

  onWorkerError: (_error, ctx) => {
    // Check if worker was stable before this failure
    const wasStable =
      ctx.lastStableTime !== null &&
      Date.now() - ctx.lastStableTime > STABILITY_WINDOW_MS

    // Reset failure count if was stable
    const effectiveFailures = wasStable ? 1 : ctx.consecutiveFailures

    if (effectiveFailures >= DEV_MAX_RETRIES) {
      return { type: 'wait' } // Stop trying, wait for HMR fix
    }

    return { type: 'restart', delay: exponentialBackoff(effectiveFailures) }
  },

  getRestartDelay: (n) => exponentialBackoff(n),
  allowDegradedMode: true,
}

/**
 * Production Error Policy
 *
 * - Startup errors: Exit immediately with code 1
 * - Worker errors: Restart up to 3 times, then exit
 * - No stability window consideration (each failure counts)
 * - Degraded mode: Not allowed (all workers must be healthy)
 */
export const ProdErrorPolicy: ErrorPolicy = {
  onStartupError: () => ({ type: 'exit', code: 1 }),

  onWorkerError: (_error, ctx) => {
    if (ctx.consecutiveFailures >= PROD_MAX_RETRIES) {
      return { type: 'exit', code: 1 }
    }
    return { type: 'restart', delay: 1000 }
  },

  getRestartDelay: () => 1000,
  allowDegradedMode: false,
}

/**
 * Get the appropriate error policy for the given mode.
 */
export function getErrorPolicy(
  mode: 'development' | 'production',
): ErrorPolicy {
  return mode === 'development' ? DevErrorPolicy : ProdErrorPolicy
}
