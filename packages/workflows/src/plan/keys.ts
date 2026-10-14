import type { RunUnique } from '../model.ts'

/** JSON with object keys in one order, so equal values give equal text. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (
      nested === null ||
      typeof nested !== 'object' ||
      Array.isArray(nested)
    ) {
      return nested
    }
    // Entries, not assignments: assigning `__proto__` would set the copy's
    // prototype and lose the key, and two different values would be equal.
    return Object.fromEntries(
      Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    )
  })
}

export function idempotencyKey(key: readonly unknown[]) {
  return `idempotency:${canonical(key)}`
}

/** The two scopes are separate key spaces, as they are separate promises. */
export function uniqueKey({ key, scope }: Pick<RunUnique, 'key' | 'scope'>) {
  return `unique:${scope}:${canonical(key)}`
}
