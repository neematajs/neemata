export function normalizeRuntimeNames(
  runtimes: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!runtimes) return undefined
  const names = runtimes.map((name) => name.trim()).filter(Boolean)
  return names.length > 0 ? names : undefined
}

export function assertRuntimeNamesExist(
  selected: readonly string[] | undefined,
  available: readonly string[],
): void {
  if (!selected) return
  const availableSet = new Set(available)
  const missing = selected.filter((name) => !availableSet.has(name))
  if (missing.length > 0) {
    throw new Error(`Unknown Neem runtime(s): ${missing.join(', ')}`)
  }
}
