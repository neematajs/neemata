import type { WriteFence } from '../../runtime/store.ts'
import type { WorkflowRedisClient } from './client.ts'
import type { Keys } from './keys.ts'
import { StaleWriteFenceError } from '../../runtime/errors.ts'
import { childKey } from './state.ts'

/**
 * Leads every script that backs a fenced write, so the fence is checked in the
 * same execution as the write. A fenced call prepends the leases and children
 * hashes to KEYS and the fence to ARGV; removing them here keeps the script's
 * own KEYS/ARGV indices unchanged. An unfenced call prepends only an empty
 * ARGV and no KEYS.
 */
export const WRITE_FENCE = `
local function writeFenceHolds()
  local encoded = table.remove(ARGV, 1)
  if encoded == '' then return true end
  local fence = cjson.decode(encoded)
  local leases = table.remove(KEYS, 1)
  local children = table.remove(KEYS, 1)
  if fence.lease then
    local raw = redis.call('HGET', leases, fence.lease.runId)
    if not raw then return false end
    local lease = cjson.decode(raw)
    local clock = redis.call('TIME')
    local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
    if lease.leaseToken ~= fence.lease.leaseToken or lease.expiresAt <= now then
      return false
    end
  end
  if fence.attempt then
    local raw = redis.call('HGET', children, fence.attempt.field)
    if not raw or cjson.decode(raw).currentAttemptId ~= fence.attempt.attemptId then
      return false
    end
  end
  return true
end
if not writeFenceHolds() then return { 'fenced' } end
`

export type FenceCall = {
  readonly keys: readonly string[]
  readonly argument: string
}

export const UNFENCED: FenceCall = { keys: [], argument: '' }

/**
 * Resolves the families holding the fence's lease and child. `known` saves the
 * lookup when the fence names the run being written, the usual case.
 */
export async function resolveWriteFence(
  client: WorkflowRedisClient,
  keys: Keys,
  fence: WriteFence | undefined,
  known?: { readonly runId: string; readonly rootRunId: string },
): Promise<FenceCall> {
  const { runLease, attempt } = fence ?? {}
  if (!runLease && !attempt) return UNFENCED
  const rootOf = async (runId: string) => {
    if (runId === known?.runId) return known.rootRunId
    const rootRunId = await client.get(keys.runRoot(runId))
    // Leases and children live and die with their family, so a fence naming
    // a run whose family is gone can no longer hold.
    if (!rootRunId) throw new StaleWriteFenceError()
    return rootRunId
  }
  const [leaseRoot, attemptRoot] = await Promise.all([
    runLease && rootOf(runLease.runId),
    attempt && rootOf(attempt.runId),
  ])
  const encoded: {
    lease?: { runId: string; leaseToken: string }
    attempt?: { field: string; attemptId: string }
  } = {}
  if (runLease) {
    encoded.lease = { runId: runLease.runId, leaseToken: runLease.leaseToken }
  }
  if (attempt) {
    encoded.attempt = {
      field: childKey(attempt.runId, attempt.nodeName, attempt.childKey),
      attemptId: attempt.attemptId,
    }
  }
  return {
    keys: [
      keys.familyLeases((leaseRoot ?? attemptRoot)!),
      keys.familyChildren((attemptRoot ?? leaseRoot)!),
    ],
    argument: JSON.stringify(encoded),
  }
}

export function assertNotFenced(result: unknown) {
  if (Array.isArray(result) && String(result[0]) === 'fenced') {
    throw new StaleWriteFenceError()
  }
}
