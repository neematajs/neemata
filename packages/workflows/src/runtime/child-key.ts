/**
 * Every node executes through child records; the child key names one child
 * within its node. Namespacing keeps user-supplied case/member keys from
 * colliding with the implicit single-child key.
 */
export const SELF_CHILD_KEY = '$self'

/** Task runs execute through one synthetic node holding the self child. */
export const TASK_RUN_NODE_NAME = '$task'

const CASE_PREFIX = 'case:'
const MEMBER_PREFIX = 'member:'
const ITEM_PREFIX = 'item:'

export type ParsedChildKey =
  | { readonly kind: 'self' }
  | { readonly kind: 'case'; readonly caseKey: string }
  | { readonly kind: 'member'; readonly memberKey: string }
  | { readonly kind: 'item'; readonly itemIndex: number }

export function caseChildKey(caseKey: string): string {
  return `${CASE_PREFIX}${caseKey}`
}

export function memberChildKey(memberKey: string): string {
  return `${MEMBER_PREFIX}${memberKey}`
}

export function itemChildKey(itemIndex: number): string {
  return `${ITEM_PREFIX}${itemIndex}`
}

export function parseChildKey(childKey: string): ParsedChildKey | undefined {
  if (childKey === SELF_CHILD_KEY) return { kind: 'self' }
  if (childKey.startsWith(CASE_PREFIX)) {
    return { kind: 'case', caseKey: childKey.slice(CASE_PREFIX.length) }
  }
  if (childKey.startsWith(MEMBER_PREFIX)) {
    return { kind: 'member', memberKey: childKey.slice(MEMBER_PREFIX.length) }
  }
  if (childKey.startsWith(ITEM_PREFIX)) {
    const itemIndex = Number(childKey.slice(ITEM_PREFIX.length))
    if (!Number.isInteger(itemIndex) || itemIndex < 0) return undefined
    return { kind: 'item', itemIndex }
  }
  return undefined
}
