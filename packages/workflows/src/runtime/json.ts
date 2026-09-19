/**
 * Idempotency, unique keys and stored inputs are compared as JSON documents:
 * the in-memory adapter holds the caller's values while postgres holds their
 * jsonb round-trip, so comparing the normalized encoding keeps both adapters
 * on the same conflict contract.
 */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]): [string, unknown] => [key, normalize(item)])
    return Object.fromEntries(entries)
  }
  return value
}

/** Stable encoding usable as a Map key. */
export function valueKey(value: unknown): string {
  return JSON.stringify(normalize(value))
}

/**
 * Absent values encode to `undefined`, so a missing value matches only
 * another missing one.
 */
export function sameValue(left: unknown, right: unknown): boolean {
  return valueKey(left) === valueKey(right)
}

/** Structural containment, mirroring the postgres `@>` operator. */
export function jsonContains(target: unknown, expected: unknown): boolean {
  if (expected === undefined) return true
  if (Array.isArray(expected)) {
    if (!Array.isArray(target)) return false
    return expected.every((item) =>
      target.some((candidate) => jsonContains(candidate, item)),
    )
  }
  if (expected && typeof expected === 'object') {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      return false
    }

    const fields = target as Record<string, unknown>
    return Object.entries(expected).every(([key, value]) =>
      jsonContains(fields[key], value),
    )
  }

  return Object.is(target, expected)
}
