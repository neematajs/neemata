import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type { CreateRunInput, RunLease } from '../../runtime/store.ts'

export type StoredLease = RunLease & { readonly expiresAt: Date }

export type Family = {
  readonly rootRunId: string
  readonly runs: Record<string, StoredRun>
  readonly nodes: Record<string, StoredNode>
  readonly children: Record<string, StoredNodeChild>
  readonly attempts: Record<string, StoredAttempt>
}

const dateKeys = new Set([
  'activeSince',
  'createdAt',
  'updatedAt',
  'dispatchedAt',
  'heartbeatAt',
  'completedAt',
  'expiresAt',
  'runAt',
  'deadAt',
  'reapedAt',
  'leaseExpiresAt',
  'nextRunAt',
  'lastSlotAt',
])

// Lua may inspect routing/state fields, but cjson cannot round-trip arbitrary
// JSON arrays and numbers. Payload fields cross Lua unchanged as JSON strings.
const payloadKeys = new Set([
  'input',
  'output',
  'item',
  'tags',
  'idempotencyKey',
  'unique',
  'error',
  'lastError',
])

export const encode = (value: unknown): string =>
  JSON.stringify(
    value,
    function (this: Record<string, unknown>, key, item: unknown) {
      if (payloadKeys.has(key)) return JSON.stringify(item)
      const original = this[key]
      if (dateKeys.has(key) && original instanceof Date)
        return original.getTime()
      return item
    },
  )

export const decode = <T>(value: string): T =>
  JSON.parse(value, (key, item: unknown) => {
    // Parsing payloads separately keeps their fields outside the metadata
    // reviver, without allocating a second copy of the record envelope.
    if (payloadKeys.has(key) && typeof item === 'string')
      return JSON.parse(item)
    if (dateKeys.has(key) && typeof item === 'number') return new Date(item)
    return item
  }) as T

export const nodeKey = (runId: string, nodeName: string) =>
  `${runId}\u0000${nodeName}`

export const childKey = (runId: string, nodeName: string, childKey: string) =>
  `${runId}\u0000${nodeName}\u0000${childKey}`

const stableJsonValue = (value: unknown): unknown => {
  // Dates serialize as ISO strings, so their identity must match stored JSON.
  if (value instanceof Date) return value.toJSON()
  if (Array.isArray(value)) {
    return Array.from(value, stableJsonValue)
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const stable: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      stable[key] = stableJsonValue(record[key])
    }
    return stable
  }
  return value
}

export const valueKey = (value: unknown) =>
  JSON.stringify(stableJsonValue(value))

export const runSignature = (run: CreateRunInput) =>
  valueKey([
    run.kind ?? 'workflow',
    run.name ?? run.taskName ?? run.workflowName,
    run.workflowName,
    run.taskName,
    run.parentRunId,
    run.parentNodeName,
    run.rootRunId,
    run.idempotencyKey,
    run.input,
  ])

export const sameValue = (left: unknown, right: unknown) =>
  valueKey(left) === valueKey(right)
