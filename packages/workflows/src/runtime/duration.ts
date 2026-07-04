export function parseDurationMs(
  duration: string | undefined,
): number | undefined {
  if (!duration) return undefined
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(duration)
  if (!match) return undefined

  const value = Number(match[1])
  const unit = match[2]
  if (!Number.isFinite(value)) return undefined
  if (unit === 'ms') return value
  if (unit === 's') return value * 1_000
  if (unit === 'm') return value * 60_000
  if (unit === 'h') return value * 3_600_000
  return value * 86_400_000
}
