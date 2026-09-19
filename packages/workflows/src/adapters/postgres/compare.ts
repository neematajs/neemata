import { isRecord } from './query.ts'

/**
 * Structural equality for idempotency, unique and input payloads. Both sides
 * have been through jsonb here, so a key walk is enough — this deliberately
 * differs from the in-memory adapter's stable-JSON compare, which has to cope
 * with live values (Dates, explicit `undefined`, `-0`).
 */
export const sameValue = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    )
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && sameValue(left[key], right[key]),
      )
    )
  }
  return false
}

export const sameOptionalValue = (left: unknown, right: unknown) =>
  left === undefined && right === undefined
    ? true
    : left !== undefined && right !== undefined && sameValue(left, right)
