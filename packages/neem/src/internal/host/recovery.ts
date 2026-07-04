import type { NeemMode } from '../../shared/types.ts'

export type RecoveryPolicy = {
  attempts: number
  delayMs: number
  factor: number
  maxDelayMs: number
}

export type RecoveryOptions = Partial<RecoveryPolicy>

export function createRecoveryPolicy(
  mode: NeemMode,
  options: RecoveryOptions = {},
): RecoveryPolicy {
  const defaults =
    mode === 'production'
      ? { attempts: 3, delayMs: 1_000, factor: 1, maxDelayMs: 1_000 }
      : { attempts: 0, delayMs: 0, factor: 1, maxDelayMs: 0 }

  return {
    attempts: nonNegativeInteger(options.attempts, defaults.attempts),
    delayMs: nonNegativeInteger(options.delayMs, defaults.delayMs),
    factor: positiveNumber(options.factor, defaults.factor),
    maxDelayMs: nonNegativeInteger(options.maxDelayMs, defaults.maxDelayMs),
  }
}

export function getRecoveryDelay(
  policy: RecoveryPolicy,
  attempt: number,
): number {
  const delay = policy.delayMs * policy.factor ** Math.max(0, attempt - 1)
  return Math.min(delay, policy.maxDelayMs)
}

function nonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

function positiveNumber(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) return fallback
  return value
}
