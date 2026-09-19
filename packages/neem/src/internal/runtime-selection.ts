export function parseRuntimeNames(
  csv: string | undefined,
): readonly string[] | undefined {
  if (!csv) return undefined
  return normalizeRuntimeNames(csv.split(','))
}

export function normalizeRuntimeNames(
  runtimes: readonly string[] | undefined,
): readonly string[] | undefined {
  if (!runtimes) return undefined

  const names = new Set<string>()
  for (const runtime of runtimes) {
    const name = runtime.trim()
    if (name) names.add(name)
  }

  return names.size > 0 ? Array.from(names) : undefined
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
