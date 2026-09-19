import type { PruneTerminalRunsParams } from './store.ts'
import { TERMINAL_RUN_STATUSES, type TerminalRunStatus } from './status.ts'

/** Shared by retention pruning, schedule firing and dead-command listing. */
export const DEFAULT_BATCH_SIZE = 100

/**
 * A fractional or non-positive batch size disables the batch instead of
 * throwing: callers treat 0 as "nothing to do" and still run the sweeps that
 * do not depend on it.
 */
export function normalizeBatchSize(
  size: number | undefined,
  fallback = DEFAULT_BATCH_SIZE,
): number {
  if (size === undefined) return fallback
  if (!Number.isInteger(size) || size < 1) return 0
  return size
}

export function normalizePruneStatuses(
  statuses: PruneTerminalRunsParams['statuses'],
): readonly TerminalRunStatus[] {
  const selected = new Set<TerminalRunStatus>()

  for (const status of statuses ?? TERMINAL_RUN_STATUSES) {
    if (TERMINAL_RUN_STATUSES.includes(status)) selected.add(status)
  }

  return Array.from(selected)
}
