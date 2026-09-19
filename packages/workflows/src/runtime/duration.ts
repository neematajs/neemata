const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
}

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/

/** Returns undefined for anything unparseable; callers decide the fallback. */
export function parseDurationMs(
  duration: string | undefined,
): number | undefined {
  if (!duration) return undefined

  const match = DURATION_PATTERN.exec(duration)
  if (!match) return undefined

  const unitMs = UNIT_MS[match[2]!]
  const value = Number(match[1])
  // the pattern admits digit runs long enough to overflow into Infinity
  if (unitMs === undefined || !Number.isFinite(value)) return undefined
  return value * unitMs
}
