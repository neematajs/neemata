import { randomUUID } from 'node:crypto'

import type {
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
  StoredRun,
} from '../../runtime/state.ts'
import type { RunLease } from '../../runtime/store.ts'

export type RedisRunLease = RunLease & { readonly expiresAt: Date }

export type RedisWorkflowFamily = {
  readonly rootRunId: string
  readonly runs: Record<string, StoredRun>
  readonly nodes: Record<string, StoredNode>
  readonly children: Record<string, StoredNodeChild>
  readonly attempts: Record<string, StoredAttempt>
  readonly runLeases: Record<string, RedisRunLease>
  readonly runOrder: Record<string, number>
  readonly externalKeys: string[]
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

export const encodeRedisValue = (value: unknown): string =>
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

export const decodeRedisValue = <T>(value: string): T =>
  JSON.parse(value, (key, item: unknown) => {
    // Parsing payloads separately keeps their fields outside the metadata
    // reviver, without allocating a second copy of the record envelope.
    if (payloadKeys.has(key) && typeof item === 'string')
      return JSON.parse(item)
    if (dateKeys.has(key) && typeof item === 'number') return new Date(item)
    return item
  }) as T

export const redisNodeKey = (runId: string, nodeName: string) =>
  `${runId}\u0000${nodeName}`

export const redisChildKey = (
  runId: string,
  nodeName: string,
  childKey: string,
) => `${runId}\u0000${nodeName}\u0000${childKey}`

export const createRedisId = () => randomUUID()

export const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    const stable: unknown[] = []
    stable.length = value.length
    for (let index = 0; index < value.length; index += 1) {
      stable[index] = stableJsonValue(value[index])
    }
    return stable
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const keys: string[] = []
    for (const key in record) {
      if (Object.hasOwn(record, key)) keys.push(key)
    }
    keys.sort()
    const stable: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      stable[key] = stableJsonValue(record[key])
    }
    return stable
  }
  return value
}

export const redisValueKey = (value: unknown) =>
  JSON.stringify(stableJsonValue(value))

export const redisRunSignature = (run: {
  readonly kind?: string
  readonly name?: string
  readonly workflowName: string
  readonly taskName?: string
  readonly parentRunId?: string
  readonly parentNodeName?: string
  readonly rootRunId?: string
  readonly idempotencyKey?: readonly unknown[]
  readonly input: unknown
}) =>
  redisValueKey([
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

export const sameRedisValue = (left: unknown, right: unknown) =>
  redisValueKey(left) === redisValueKey(right)

export const sameOptionalRedisValue = (left: unknown, right: unknown) => {
  if (left === undefined) return right === undefined
  if (right === undefined) return false
  return sameRedisValue(left, right)
}
