/**
 * Every node executes through child records; the child key names one child
 * within its node. Namespacing keeps user-supplied case/member keys from
 * colliding with the implicit single-child key.
 */
export const SELF_CHILD_KEY = '$self'

export type ParsedChildKey =
  | { readonly kind: 'self' }
  | { readonly kind: 'case'; readonly caseKey: string }
  | { readonly kind: 'member'; readonly memberKey: string }
  | { readonly kind: 'item'; readonly itemIndex: number }

export function caseChildKey(caseKey: string): string {
  return `case:${caseKey}`
}

export function memberChildKey(memberKey: string): string {
  return `member:${memberKey}`
}

export function itemChildKey(itemIndex: number): string {
  return `item:${itemIndex}`
}

export function parseChildKey(childKey: string): ParsedChildKey | undefined {
  if (childKey === SELF_CHILD_KEY) return { kind: 'self' }
  if (childKey.startsWith('case:')) {
    return { kind: 'case', caseKey: childKey.slice('case:'.length) }
  }
  if (childKey.startsWith('member:')) {
    return { kind: 'member', memberKey: childKey.slice('member:'.length) }
  }
  if (childKey.startsWith('item:')) {
    const itemIndex = Number(childKey.slice('item:'.length))
    if (!Number.isInteger(itemIndex) || itemIndex < 0) return undefined
    return { kind: 'item', itemIndex }
  }
  return undefined
}

export function childKeyMemberKey(childKey: string): string | undefined {
  const parsed = parseChildKey(childKey)
  return parsed?.kind === 'member' ? parsed.memberKey : undefined
}

export function childKeyCaseKey(childKey: string): string | undefined {
  const parsed = parseChildKey(childKey)
  return parsed?.kind === 'case' ? parsed.caseKey : undefined
}
