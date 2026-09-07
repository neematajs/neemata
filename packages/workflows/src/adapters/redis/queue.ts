import { randomUUID } from 'node:crypto'

import type {
  AttemptCommand,
  ContinueRunCommand,
  ExecutionWorkerClaim,
  RunCoordinationWorkerClaim,
} from '../../runtime/commands.ts'
import type { CommandReleaseOptions } from '../../runtime/executors.ts'
import type { StoredError, StoredRun } from '../../runtime/state.ts'
import type { DeadWorkflowCommand } from '../../runtime/store.ts'
import type { WorkflowCommandWakeKind } from '../../runtime/wake-events.ts'
import type { WorkflowRedisClient } from './client.ts'
import type { Keys } from './keys.ts'
import {
  COMMAND_LEASE_EXPIRED_ERROR,
  toStoredError,
} from '../../runtime/errors.ts'
import { QueueScripts } from './scripts.ts'
import { decode, encode } from './state.ts'

const RELEASE_BACKOFF_MS = 50
const UNROUTABLE_BACKOFF_MS = 1_000
const MAX_ERROR_BACKOFF_MS = 300_000
const QUEUE_BATCH_SIZE = 128

type Kind = 'continue' | 'attempt'

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

type Item<T> = {
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

type Claim<T> = {
  readonly id: string
  readonly command: T
  readonly leaseToken: string
}

type ClaimSelector = ExecutionWorkerClaim | RunCoordinationWorkerClaim

type Options<T> = {
  readonly client: WorkflowRedisClient
  readonly keys: Keys
  readonly kind: Kind
  readonly maxDeliveries: number
  readonly dedupKey: (payload: T) => string
}

export class Queue<T extends AttemptCommand | ContinueRunCommand> {
  readonly #client: WorkflowRedisClient
  readonly #keys: Keys
  readonly #kind: Kind
  readonly #maxDeliveries: number
  readonly #dedupKey: Options<T>['dedupKey']
  readonly #scripts: QueueScripts

  constructor(options: Options<T>) {
    this.#client = options.client
    this.#keys = options.keys
    this.#kind = options.kind
    this.#maxDeliveries = options.maxDeliveries
    this.#dedupKey = options.dedupKey
    this.#scripts = new QueueScripts(options.client)
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
    const item: Mutable<Item<T>> = {
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
    const markerTarget = markerKey || queue.items
    const hasMarker = markerKey ? '1' : '0'
    // Deduplication and scheduling happen in the script so contention cannot
    // turn into an unbounded client-side compare-and-swap loop.
    await this.#scripts.run(
      'enqueue',
      [
        queue.items,
        queue.ready,
        queue.dedup,
        markerTarget,
        this.#keys.commandWake(commandKind(payload)),
        this.#keys.runRoot(payload.runId),
      ],
      [
        this.#dedupKey(payload),
        this.#kind,
        encode(item),
        hasMarker,
        this.#keys.prefix,
      ],
    )
  }

  async claim(
    selector: ClaimSelector,
    leaseMs: number,
  ): Promise<Claim<T> | null> {
    if (!selectorCanClaim(selector)) return null
    await this.#reclaimExpired(selector)
    return await this.#claimReady(selector, leaseMs)
  }

  async #claimReady(
    selector: ClaimSelector,
    leaseMs: number,
  ): Promise<Claim<T> | null> {
    const queue = this.#keys.queue(this.#kind)
    const leaseToken = randomUUID()
    while (true) {
      const result = scriptResult(
        await this.#scripts.runRaw(
          'claim',
          [queue.items, queue.ready, queue.claimed, queue.dead, queue.dedup],
          [
            String(QUEUE_BATCH_SIZE),
            encode(selector),
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
        const item = decode<Item<T>>(raw)
        return { id, command: item.payload, leaseToken }
      }
      throw new Error('Redis returned an invalid workflow claim result')
    }
  }

  async heartbeat(
    claim: Claim<T>,
    leaseMs: number,
  ): Promise<{ runStatus: StoredRun['status'] } | undefined> {
    const queue = this.#keys.queue(this.#kind)
    const result = scriptResult(
      await this.#scripts.runRaw(
        'heartbeat',
        [queue.items, queue.claimed],
        [claim.id, claim.leaseToken, String(leaseMs), this.#keys.prefix],
      ),
    )
    if (result.length === 0) return undefined
    const run = decode<Pick<StoredRun, 'status'>>(result[0]!)
    return { runStatus: run.status }
  }

  async ack(claim: Claim<T>): Promise<void> {
    const queue = this.#keys.queue(this.#kind)
    const raw = await this.#client.hget(queue.items, claim.id)
    if (!raw) throw new Error('Stale workflow command ack')
    const item = decode<Item<T>>(raw)
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
    claim: Claim<T>,
    options?: CommandReleaseOptions,
  ): Promise<void> {
    const queue = this.#keys.queue(this.#kind)
    const raw = await this.#client.hget(queue.items, claim.id)
    if (!raw) return
    const item = decode<Item<T>>(raw)
    if (!matchesClaim(item, claim)) return
    const released = releaseItem(clearClaim(item), options, this.#maxDeliveries)
    await this.#scripts.run(
      'releaseClaimed',
      [
        queue.items,
        queue.claimed,
        queue.ready,
        queue.dead,
        this.#keys.commandWake(commandKind(item.payload)),
        queue.dedup,
      ],
      [
        item.id,
        raw,
        encode(released.item),
        String(released.delayMs),
        released.dead ? '1' : '0',
      ],
    )
  }

  async listDead(runId?: string): Promise<readonly DeadWorkflowCommand[]> {
    return this.#listDead(true, undefined, runId)
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
    return this.#listDead(false, limit)
  }

  async #listDead(newest: boolean, limit?: number, runId?: string) {
    if (limit !== undefined && limit < 1) return []
    const queue = this.#keys.queue(this.#kind)
    const dead: DeadWorkflowCommand[] = []
    for (let offset = 0; ; ) {
      const size = QUEUE_BATCH_SIZE
      const result = scriptResult(
        await this.#scripts.runRaw(
          'listDead',
          [queue.items, queue.ready, queue.claimed, queue.dead, queue.dedup],
          [
            String(offset),
            String(size),
            newest ? '1' : '0',
            this.#keys.prefix,
            runId ?? '',
            newest ? '0' : '1',
            String(limit === undefined ? size : limit - dead.length),
          ],
        ),
      )
      const inspected = Number(result[0])
      for (const raw of result.slice(1)) {
        const item = decode<Item<T>>(raw)
        dead.push(this.#mapDead(item))
      }
      if (inspected < size || (limit !== undefined && dead.length >= limit))
        break
      offset += inspected
    }
    return dead
  }

  async markReaped(id: string): Promise<boolean> {
    const queue = this.#keys.queue(this.#kind)
    const raw = await this.#client.hget(queue.items, id)
    if (!raw) return false
    const item = decode<Item<T>>(raw)
    if (!item.deadAt || item.reapedAt !== undefined) return false
    const result = await this.#scripts.run(
      'updateDead',
      [queue.items, queue.dead],
      [id, raw, encode({ ...item, reapedAt: new Date() })],
    )
    return result === 1
  }

  async requeueDead(id: string): Promise<boolean> {
    const queue = this.#keys.queue(this.#kind)
    const raw = await this.#client.hget(queue.items, id)
    if (!raw) return false
    const item = decode<Item<T>>(raw)
    if (!item.deadAt) return false
    const requeued: Mutable<Item<T>> = {
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
        encode(requeued),
        String(requeued.createdAtScore),
        this.#dedupKey(requeued.payload),
      ],
    )
    if (moved !== 1) return false
    const kind = commandKind(item.payload)
    await this.#client.publish(this.#keys.commandWake(kind), '1')
    return true
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
    const ids = Array.from(runIds)
    for (let offset = 0; offset < ids.length; offset += QUEUE_BATCH_SIZE) {
      const batch = JSON.stringify(ids.slice(offset, offset + QUEUE_BATCH_SIZE))
      let position = '1'
      let cursor = '0'
      let changed = '0'
      do {
        const result = scriptResult(
          await this.#scripts.runRaw(
            'deleteForRuns',
            [queue.items, queue.ready, queue.claimed, queue.dead, queue.dedup],
            [
              position,
              cursor,
              String(QUEUE_BATCH_SIZE),
              this.#keys.prefix,
              unclaimedOnly ? '1' : '0',
              batch,
              changed,
            ],
          ),
        )
        position = result[0]!
        cursor = result[1]!
        deleted += Number(result[2])
        changed = result[3]!
      } while (position !== '0')
    }
    return deleted
  }

  async prune(olderThan: Date): Promise<void> {
    const queue = this.#keys.queue(this.#kind)
    // Routed workers no longer visit abandoned routes; maintenance owns their
    // expired-family cleanup, including delayed and still-leased commands.
    await this.#pruneOrphans(queue.ready, queue.claimed, queue.dead)
    let count: number
    do {
      count = await this.#scripts.run(
        'pruneDead',
        [queue.items, queue.ready, queue.claimed, queue.dead, queue.dedup],
        [String(olderThan.getTime()), String(QUEUE_BATCH_SIZE)],
      )
    } while (count === QUEUE_BATCH_SIZE)
  }

  async #reclaimExpired(selector: ClaimSelector) {
    const queue = this.#keys.queue(this.#kind)
    let position = 1
    do {
      position = await this.#scripts.run(
        'reclaimExpired',
        [queue.items, queue.ready, queue.claimed, queue.dead, queue.dedup],
        [
          String(position),
          String(QUEUE_BATCH_SIZE),
          encode(selector),
          String(this.#maxDeliveries),
          encode({ lastError: COMMAND_LEASE_EXPIRED_ERROR }),
          this.#keys.prefix,
        ],
      )
    } while (position !== 0)
  }

  async #pruneOrphans(...indexes: string[]) {
    const queue = this.#keys.queue(this.#kind)
    const keys = [
      queue.items,
      queue.ready,
      queue.claimed,
      queue.dead,
      queue.dedup,
      ...indexes,
    ]
    let cursors = indexes.map(() => '0')
    let changedInPass = false
    while (true) {
      const result = scriptResult(
        await this.#scripts.runRaw('pruneOrphans', keys, [
          String(QUEUE_BATCH_SIZE),
          this.#keys.prefix,
          ...cursors,
        ]),
      )
      changedInPass ||= result[0] === '1'
      cursors = result.slice(1)
      if (cursors.some((cursor) => cursor !== '')) continue
      if (!changedInPass) return
      // Deleting entries while scanning can move buckets; finish a clean pass.
      cursors.fill('0')
      changedInPass = false
    }
  }

  async #loadItem(id: string): Promise<Item<T> | undefined> {
    const value = await this.#client.hget(
      this.#keys.queue(this.#kind).items,
      id,
    )
    if (!value) return undefined
    return decode<Item<T>>(value)
  }

  #mapDead(item: Item<T>): DeadWorkflowCommand {
    const { payload, deadAt } = item
    if (!deadAt) throw new Error(`Workflow command [${item.id}] is not dead`)
    const command: Mutable<DeadWorkflowCommand> = {
      id: item.id,
      kind: commandKind(item.payload),
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

const commandKind = (
  command: AttemptCommand | ContinueRunCommand,
): WorkflowCommandWakeKind => {
  if (command.kind === 'continueRun') return 'continue'
  if (command.kind === 'activityAttempt') return 'activity'
  return 'task'
}

const matchesClaim = <T>(item: Item<T>, claim: Pick<Claim<T>, 'leaseToken'>) =>
  item.leaseToken === claim.leaseToken

const selectorCanClaim = (selector: ClaimSelector) => {
  if (selector.workflowNames.length > 0) return true
  if (!('taskNames' in selector)) return false
  return selector.taskNames.length > 0
}

const scriptResult = (value: unknown): string[] => {
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

const clearClaim = <T>(item: Item<T>): Item<T> => {
  const {
    leaseToken: _leaseToken,
    leaseExpiresAt: _leaseExpiresAt,
    ...rest
  } = item
  return rest
}

const releaseItem = <T>(
  item: Item<T>,
  options: CommandReleaseOptions | undefined,
  maxDeliveries: number,
): {
  readonly item: Item<T>
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
  const deliveryCount = item.deliveryCount + 1
  const lastError = toStoredError(error)
  const failed = { ...item, deliveryCount, lastError }
  const delayMs = Math.min(2 ** deliveryCount * base, MAX_ERROR_BACKOFF_MS)
  const dead = deliveryCount >= maxDeliveries
  return { item: failed, delayMs, dead }
}
