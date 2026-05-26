import type { NeemMode } from '../../public/runtime.ts'

export type NeemRuntimeRecoveryPolicy = {
  attempts: number
  delayMs: number
  factor: number
  maxDelayMs: number
}

export type NeemRuntimeRecoveryOptions = Partial<NeemRuntimeRecoveryPolicy>

export function createRuntimeRecoveryPolicy(
  mode: NeemMode,
  options: NeemRuntimeRecoveryOptions = {},
): NeemRuntimeRecoveryPolicy {
  const defaults =
    mode === 'production'
      ? { attempts: 3, delayMs: 1_000, factor: 1, maxDelayMs: 1_000 }
      : { attempts: 0, delayMs: 0, factor: 1, maxDelayMs: 0 }

  return {
    attempts: normalizeNonNegativeInteger(options.attempts, defaults.attempts),
    delayMs: normalizeNonNegativeInteger(options.delayMs, defaults.delayMs),
    factor: normalizePositiveNumber(options.factor, defaults.factor),
    maxDelayMs: normalizeNonNegativeInteger(
      options.maxDelayMs,
      defaults.maxDelayMs,
    ),
  }
}

export function getRuntimeRecoveryDelay(
  policy: NeemRuntimeRecoveryPolicy,
  attempt: number,
): number {
  const delay = policy.delayMs * policy.factor ** Math.max(0, attempt - 1)
  return Math.min(delay, policy.maxDelayMs)
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < 0) return fallback
  return Math.floor(value)
}

function normalizePositiveNumber(
  value: number | undefined,
  fallback: number,
): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) return fallback
  return value
}
