import { randomUUID } from 'node:crypto'

import type {
  AttemptCommand,
  ClaimedAttempt,
  ClaimedCommand,
  ContinueRunCommand,
  ExecutionWorkerClaim,
  RunCoordinationWorkerClaim,
} from '../../runtime/commands.ts'
import type { CommandReleaseOptions } from '../../runtime/executors.ts'
import type { StoredError } from '../../runtime/state.ts'
import type { DeadWorkflowCommand } from '../../runtime/store.ts'
import type { WorkflowCommandWakeKind } from '../../runtime/wake-events.ts'
import type { WorkflowRedisClient } from './client.ts'
import type { RedisWorkflowKeys } from './keys.ts'
import {
  COMMAND_LEASE_EXPIRED_ERROR,
  toStoredError,
} from '../../runtime/errors.ts'
import { RedisWorkflowScripts } from './scripts.ts'
import { decodeRedisValue, encodeRedisValue } from './state.ts'

const RELEASE_BACKOFF_MS = 50
const UNROUTABLE_BACKOFF_MS = 1_000
const MAX_ERROR_BACKOFF_MS = 300_000
const QUEUE_BATCH_SIZE = 128

type QueueKind = 'continue' | 'attempt'

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

type RedisQueueItem<T> = {
  readonly id: string
  readonly payload: T
  readonly rootRunId?: string
  readonly runAt?: Date
  readonly runAtScore?: number
  readonly deliveryCount: number
  readonly lastError?: StoredError
  readonly deadAt?: Date
  readonly reapedAt?: Date
  readonly createdAt: Date
  readonly createdAtScore: number
  readonly leaseToken?: string
  readonly leaseExpiresAt?: Date
}

type QueueClaim<T> = {
  readonly id: string
  readonly command: T
  readonly leaseToken: string
}

type QueueClaimSelector = ExecutionWorkerClaim | RunCoordinationWorkerClaim

type QueueOptions<T> = {
  readonly client: WorkflowRedisClient
  readonly keys: RedisWorkflowKeys
  readonly kind: QueueKind
  readonly maxDeliveries: number
  readonly wakeKind: (payload: T) => 'continue' | 'activity' | 'task'
  readonly dedupKey: (payload: T) => string
  readonly deadKind: (payload: T) => DeadWorkflowCommand['kind']
}

export class RedisWorkflowQueue<T extends AttemptCommand | ContinueRunCommand> {
  readonly #client: WorkflowRedisClient
  readonly #keys: RedisWorkflowKeys
  readonly #kind: QueueKind
  readonly #maxDeliveries: number
  readonly #wakeKind: QueueOptions<T>['wakeKind']
  readonly #dedupKey: QueueOptions<T>['dedupKey']
  readonly #deadKind: QueueOptions<T>['deadKind']
  readonly #scripts: RedisWorkflowScripts

  constructor(options: QueueOptions<T>) {
    this.#client = options.client
    this.#keys = options.keys
    this.#kind = options.kind
    this.#maxDeliveries = options.maxDeliveries
    this.#wakeKind = options.wakeKind
    this.#dedupKey = options.dedupKey
    this.#deadKind = options.deadKind
    this.#scripts = new RedisWorkflowScripts(options.client)
  }

  async enqueueWithMarker(
    payload: T,
    markerKey: string,
    runAt?: Date,
  ): Promise<void> {
    await this.#enqueue(payload, runAt, markerKey)
  }

  async enqueue(payload: T, runAt?: Date): Promise<void> {
    await this.#enqueue(payload, runAt)
  }

  async #enqueue(
    payload: T,
    runAt: Date | undefined,
    markerKey?: string,
  ): Promise<void> {
    const queue = this.#keys.queue(this.#kind)
    const createdAt = new Date()
    const item: Mutable<RedisQueueItem<T>> = {
      id: randomUUID(),
      payload,
      deliveryCount: 0,
      createdAt,
      createdAtScore: createdAt.getTime(),
    }
    if (runAt !== undefined) {
      item.runAt = runAt
      item.runAtScore = runAt.getTime()
    }
    let markerTarget = queue.items
    let hasMarker = '0'
    if (markerKey) {
      markerTarget = markerKey
      hasMarker = '1'
    }
    // Deduplication and scheduling happen in the script so contention cannot
    // turn into an unbounded client-side compare-and-swap loop.
    await this.#scripts.run(
      'enqueue',
      [
        queue.items,
        queue.ready,
        queue.dedup,
        markerTarget,
        this.#keys.commandWake(this.#wakeKind(payload)),
        this.#keys.runRoot(payload.runId),
      ],
      [
        this.#dedupKey(payload),
        this.#kind,
        encodeRedisValue(item),
        hasMarker,
        this.#keys.prefix,
      ],
    )
  }

  async claim(
    selector: QueueClaimSelector,
    leaseMs: number,
  ): Promise<QueueClaim<T> | null> {
    if (!selectorCanClaim(selector)) return null
    await this.#reclaimExpired(selector)
    return await this.#claimReady(selector, leaseMs)
  }

  async #claimReady(
    selector: QueueClaimSelector,
    leaseMs: number,
  ): Promise<QueueClaim<T> | null> {
    const queue = this.#keys.queue(this.#kind)
    const leaseToken = randomUUID()
    while (true) {
      const result = queueScriptResult(
        await this.#scripts.runRaw(
          'claim',
          [queue.items, queue.ready, queue.claimed, queue.dead, queue.dedup],
          [
            String(QUEUE_BATCH_SIZE),
            encodeRedisValue(selector),
            leaseToken,
            String(leaseMs),
            this.#keys.prefix,
          ],
        ),
      )
      if (result[0] === 'empty') return null
      if (result[0] === 'more') continue
      if (result[0] === 'claimed') {
        const id = result[1]
        const raw = result[2]
        if (!id || !raw) {
          throw new Error('Redis returned an invalid workflow claim result')
        }
        const item = decodeRedisValue<RedisQueueItem<T>>(raw)
        return { id, command: item.payload, leaseToken }
      }
      throw new Error('Redis returned an invalid workflow claim result')
    }
  }

  async heartbeat(claim: QueueClaim<T>, leaseMs: number): Promise<boolean> {
    const queue = this.#keys.queue(this.#kind)
    const raw = await this.#client.hget(queue.items, claim.id)
    if (!raw) return false
    const item = decodeRedisValue<RedisQueueItem<T>>(raw)
    if (!matchesClaim(item, claim)) return false
    const result = await this.#scripts.run(
      'heartbeat',
      [queue.items, queue.claimed],
      [item.id, raw, String(leaseMs)],
    )
    return result === 1
  }

  async ack(claim: QueueClaim<T>): Promise<void> {
    const queue = this.#keys.queue(this.#kind)
    const raw = await this.#client.hget(queue.items, claim.id)
    if (!raw) throw new Error('Stale workflow command ack')
    const item = decodeRedisValue<RedisQueueItem<T>>(raw)
    if (!matchesClaim(item, claim)) {
      throw new Error('Stale workflow command ack')
    }
    const deleted = await this.#scripts.run(
      'deleteCommand',
      [queue.items, queue.claimed, queue.ready, queue.dead, queue.dedup],
      [item.id, raw, this.#dedupKey(item.payload)],
    )
    if (deleted !== 1) throw new Error('Stale workflow command ack')
  }

  async release(
    claim: QueueClaim<T>,
    options?: CommandReleaseOptions,
  ): Promise<void> {
    const queue = this.#keys.queue(this.#kind)
    const raw = await this.#client.hget(queue.items, claim.id)
    if (!raw) return
    const item = decodeRedisValue<RedisQueueItem<T>>(raw)
    if (!matchesClaim(item, claim)) return
    const released = releaseQueueItem(
      clearClaim(item),
      options,
      this.#maxDeliveries,
    )
    let deadFlag = '0'
    if (released.dead) deadFlag = '1'
    await this.#scripts.run(
      'releaseClaimed',
      [
        queue.items,
        queue.claimed,
        queue.ready,
        queue.dead,
        this.#keys.commandWake(this.#wakeKind(item.payload)),
        queue.dedup,
      ],
      [
        item.id,
        raw,
        encodeRedisValue(released.item),
        String(released.delayMs),
        deadFlag,
      ],
    )
  }

  async listDead(runId?: string): Promise<readonly DeadWorkflowCommand[]> {
    const queue = this.#keys.queue(this.#kind)
    await this.#pruneOrphans(queue.dead)
    const ids = await this.#client.zrevrange(queue.dead, 0, -1)
    const dead: DeadWorkflowCommand[] = []
    for (const id of ids) {
      const item = await this.#loadItem(id)
      if (!item || !item.deadAt) continue
      if (runId !== undefined && item.payload.runId !== runId) continue
      dead.push(this.#mapDead(item))
    }
    return dead
  }

  async listUnreaped(
    limit?: number,
    commandId?: string,
  ): Promise<readonly DeadWorkflowCommand[]> {
    if (commandId !== undefined) {
      const item = await this.#loadItem(commandId)
      if (!item || !item.deadAt || item.reapedAt !== undefined) return []
      return [this.#mapDead(item)]
    }

    const queue = this.#keys.queue(this.#kind)
    await this.#pruneOrphans(queue.dead)
    const ids = await this.#client.zrange(queue.dead, '0', '-1')
    const dead: DeadWorkflowCommand[] = []
    for (const id of ids) {
      const item = await this.#loadItem(id)
      if (!item || !item.deadAt) continue
      if (item.reapedAt !== undefined) continue
      dead.push(this.#mapDead(item))
      if (limit !== undefined && dead.length >= limit) break
    }
    return dead
  }

  async markReaped(id: string): Promise<boolean> {
    const queue = this.#keys.queue(this.#kind)
    const raw = await this.#client.hget(queue.items, id)
    if (!raw) return false
    const item = decodeRedisValue<RedisQueueItem<T>>(raw)
    if (!item.deadAt || item.reapedAt !== undefined) return false
    const result = await this.#scripts.run(
      'updateDead',
      [queue.items, queue.dead],
      [id, raw, encodeRedisValue({ ...item, reapedAt: new Date() })],
    )
    return result === 1
  }

  async requeueDead(id: string): Promise<boolean> {
    const queue = this.#keys.queue(this.#kind)
    let wakeKind: WorkflowCommandWakeKind | undefined
    const raw = await this.#client.hget(queue.items, id)
    if (!raw) return false
    const item = decodeRedisValue<RedisQueueItem<T>>(raw)
    if (!item.deadAt) return false
    const requeued: Mutable<RedisQueueItem<T>> = {
      id: item.id,
      payload: item.payload,
      deliveryCount: 0,
      createdAt: item.createdAt,
      createdAtScore: item.createdAtScore,
    }
    if (item.rootRunId !== undefined) requeued.rootRunId = item.rootRunId
    const moved = await this.#scripts.run(
      'transitionDead',
      [queue.items, queue.dead, queue.ready, queue.dedup],
      [
        id,
        raw,
        encodeRedisValue(requeued),
        String(readyScore(requeued)),
        this.#dedupKey(requeued.payload),
      ],
    )
    const didRequeue = moved === 1
    if (didRequeue) {
      wakeKind = this.#wakeKind(item.payload)
    }
    if (wakeKind) {
      await this.#client.publish(this.#keys.commandWake(wakeKind), '1')
    }
    return didRequeue
  }

  deleteUnclaimed(runIds: ReadonlySet<string>): Promise<number> {
    return this.#deleteForRuns(runIds, true)
  }

  async deleteForRuns(runIds: ReadonlySet<string>): Promise<void> {
    await this.#deleteForRuns(runIds, false)
  }

  async #deleteForRuns(runIds: ReadonlySet<string>, unclaimedOnly: boolean) {
    const queue = this.#keys.queue(this.#kind)
    let deleted = 0
    for (const runId of runIds) {
      let cursor = '0'
      let changedInPass = false
      while (true) {
        const result = queueScriptResult(
          await this.#scripts.runRaw(
            'deleteForRuns',
            [queue.items, queue.ready, queue.claimed, queue.dead, queue.dedup],
            [
              cursor,
              String(QUEUE_BATCH_SIZE),
              runId,
              this.#keys.prefix,
              unclaimedOnly ? '1' : '0',
            ],
          ),
        )
        deleted += Number(result[1] ?? 0)
        changedInPass ||= result[2] !== '0'
        cursor = result[0] ?? '0'
        if (cursor !== '0') continue
        if (!changedInPass) break
        changedInPass = false
      }
    }
    return deleted
  }

  async prune(olderThan: Date): Promise<void> {
    const queue = this.#keys.queue(this.#kind)
    // Routed workers no longer visit abandoned routes; maintenance owns their
    // expired-family cleanup, including delayed and still-leased commands.
    await Promise.all([
      this.#pruneOrphans(queue.ready),
      this.#pruneOrphans(queue.claimed),
      this.#pruneOrphans(queue.dead),
    ])
    const ids = await this.#client.zrangebyscore(
      queue.dead,
      '-inf',
      String(olderThan.getTime()),
    )
    for (const id of ids) {
      const raw = await this.#client.hget(queue.items, id)
      if (!raw) continue
      const item = decodeRedisValue<RedisQueueItem<T>>(raw)
      await this.#deleteIndexed(item, raw, queue.dead)
    }
  }

  asContinueClaim(
    this: RedisWorkflowQueue<ContinueRunCommand>,
    claim: QueueClaim<ContinueRunCommand>,
  ): ClaimedCommand {
    return claim
  }

  asAttemptClaim(
    this: RedisWorkflowQueue<AttemptCommand>,
    claim: QueueClaim<AttemptCommand>,
  ): ClaimedAttempt {
    return claim
  }

  async #reclaimExpired(selector: QueueClaimSelector) {
    const queue = this.#keys.queue(this.#kind)
    let position = 1
    do {
      position = await this.#scripts.run(
        'reclaimExpired',
        [queue.items, queue.ready, queue.claimed, queue.dead, queue.dedup],
        [
          String(position),
          String(QUEUE_BATCH_SIZE),
          encodeRedisValue(selector),
          String(this.#maxDeliveries),
          encodeRedisValue({ lastError: COMMAND_LEASE_EXPIRED_ERROR }),
          this.#keys.prefix,
        ],
      )
    } while (position !== 0)
  }

  async #pruneOrphans(index: string) {
    const queue = this.#keys.queue(this.#kind)
    let indexPosition = 4
    if (index === queue.ready) indexPosition = 2
    if (index === queue.claimed) indexPosition = 3
    let cursor = '0'
    let changedInPass = false
    while (true) {
      const result = queueScriptResult(
        await this.#scripts.runRaw(
          'pruneOrphans',
          [queue.items, queue.ready, queue.claimed, queue.dead, queue.dedup],
          [
            cursor,
            String(QUEUE_BATCH_SIZE),
            this.#keys.prefix,
            String(indexPosition),
          ],
        ),
      )
      changedInPass ||= result[1] !== '0'
      cursor = result[0] ?? '0'
      if (cursor !== '0') continue
      if (!changedInPass) return
      changedInPass = false
    }
  }

  async #loadItem(id: string): Promise<RedisQueueItem<T> | undefined> {
    const value = await this.#client.hget(
      this.#keys.queue(this.#kind).items,
      id,
    )
    if (!value) return undefined
    return decodeRedisValue<RedisQueueItem<T>>(value)
  }

  #deleteIndexed(item: RedisQueueItem<T>, raw: string, requiredIndex: string) {
    const queue = this.#keys.queue(this.#kind)
    return this.#scripts.run(
      'deleteCommand',
      [queue.items, requiredIndex, queue.ready, queue.claimed, queue.dedup],
      [item.id, raw, this.#dedupKey(item.payload)],
    )
  }

  #mapDead(item: RedisQueueItem<T>): DeadWorkflowCommand {
    const payload = item.payload as T & Partial<AttemptCommand>
    const deadAt = item.deadAt
    if (!deadAt) throw new Error(`Workflow command [${item.id}] is not dead`)
    const command: Mutable<DeadWorkflowCommand> = {
      id: item.id,
      kind: this.#deadKind(item.payload),
      runId: payload.runId,
      payload,
      deliveryCount: item.deliveryCount,
      deadAt,
      createdAt: item.createdAt,
    }
    if ('workflowName' in payload) command.workflowName = payload.workflowName
    if ('taskName' in payload) command.taskName = payload.taskName
    if ('activityName' in payload) command.activityName = payload.activityName
    if ('nodeName' in payload) command.nodeName = payload.nodeName
    if ('attemptId' in payload) command.attemptId = payload.attemptId
    if (item.lastError !== undefined) command.lastError = item.lastError
    return command
  }
}

export type RedisContinueQueue = RedisWorkflowQueue<ContinueRunCommand>
export type RedisAttemptQueue = RedisWorkflowQueue<AttemptCommand>

const readyScore = (
  item: Pick<RedisQueueItem<unknown>, 'runAtScore' | 'createdAtScore'>,
) => item.runAtScore ?? item.createdAtScore

const matchesClaim = <T>(
  item: RedisQueueItem<T> | undefined,
  claim: Pick<QueueClaim<T>, 'leaseToken'>,
) => item?.leaseToken === claim.leaseToken

const selectorCanClaim = (selector: QueueClaimSelector) => {
  if (selector.workflowNames.length > 0) return true
  if (!('taskNames' in selector)) return false
  return selector.taskNames.length > 0
}

const queueScriptResult = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    throw new Error('Redis returned an invalid workflow script result')
  }
  const result: string[] = []
  for (const item of value) {
    if (typeof item === 'string') {
      result.push(item)
      continue
    }
    if (Buffer.isBuffer(item)) {
      result.push(item.toString())
      continue
    }
    throw new Error('Redis returned an invalid workflow script value')
  }
  return result
}

const clearClaim = <T>(item: RedisQueueItem<T>): RedisQueueItem<T> => {
  const {
    leaseToken: _leaseToken,
    leaseExpiresAt: _leaseExpiresAt,
    ...rest
  } = item
  return rest
}

const countFailedDelivery = <T>(
  item: RedisQueueItem<T>,
  error: StoredError,
): RedisQueueItem<T> => {
  const deliveryCount = item.deliveryCount + 1
  const failed: Mutable<RedisQueueItem<T>> = {
    ...item,
    deliveryCount,
    lastError: error,
  }
  return failed
}

const releaseQueueItem = <T>(
  item: RedisQueueItem<T>,
  options: CommandReleaseOptions | undefined,
  maxDeliveries: number,
): {
  readonly item: RedisQueueItem<T>
  readonly delayMs: number
  readonly dead: boolean
} => {
  if (options?.error === undefined && options?.reason === undefined) {
    return { item, delayMs: RELEASE_BACKOFF_MS, dead: false }
  }

  let base = RELEASE_BACKOFF_MS
  if (options.reason === 'unroutable') base = UNROUTABLE_BACKOFF_MS
  const error =
    options.error ?? new Error('No implementation can execute this command')
  const counted = countFailedDelivery(item, toStoredError(error))
  return {
    item: counted,
    delayMs: Math.min(2 ** counted.deliveryCount * base, MAX_ERROR_BACKOFF_MS),
    dead: counted.deliveryCount >= maxDeliveries,
  }
}
