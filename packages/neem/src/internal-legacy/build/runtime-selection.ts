export function normalizeSelectedRuntimeNames(
  runtimes: readonly string[] | undefined,
): readonly string[] | undefined {
  const selected = runtimes?.map((runtime) => runtime.trim()).filter(Boolean)
  return selected && selected.length > 0 ? [...new Set(selected)] : undefined
}

export function assertSelectedRuntimeNamesExist(
  selected: readonly string[] | undefined,
  available: readonly string[],
): void {
  if (!selected) return
  const availableNames = new Set(available)
  const missing = selected.filter((name) => !availableNames.has(name))
  if (missing.length > 0) {
    throw new Error(`Unknown Neem runtime(s): ${missing.join(', ')}`)
  }
}
