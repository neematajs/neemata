import * as Net from 'node:net'

import * as NodeRedis from '@effect/platform-node/NodeRedis'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Redis from 'effect/persistence/Redis'

import type { RedisOptions } from '../src/redis/index.ts'
import type { StoreHarness } from './store-contract.ts'
import * as RedisStore from '../src/redis/index.ts'
import { Store } from '../src/store.ts'

/** The servers these tests run against. Without them, they are skipped. */
export const SERVERS = [
  ['Redis', process.env.REDIS_URL],
  ['Valkey', process.env.VALKEY_URL],
] as const

export const client = (url: string) => Layer.orDie(NodeRedis.layer({ url }))

/** Every key of the store with this prefix, found as no store ever looks. */
export const keys = Effect.fnUntraced(function* (prefix: string) {
  const redis = yield* Redis.Redis
  const found: string[] = []
  let cursor = '0'
  do {
    const [next, batch] = yield* redis.send<[string, string[]]>(
      'SCAN',
      cursor,
      'MATCH',
      `{${prefix}}*`,
      'COUNT',
      '1000',
    )
    found.push(...batch)
    cursor = next
  } while (cursor !== '0')
  return found.toSorted()
}, Effect.orDie)

/** What every key of the store holds, by the key without its prefix. */
export const dump = Effect.fnUntraced(function* (prefix: string) {
  const redis = yield* Redis.Redis
  const contents: Record<string, unknown> = {}
  for (const key of yield* keys(prefix)) {
    const type = yield* redis.send<string>('TYPE', key)
    // A driver may answer in either protocol: pairs as a flat list, or not.
    const flat = (reply: unknown) =>
      Array.isArray(reply)
        ? reply.flat().map(String)
        : Object.entries(reply as object)
            .flat()
            .map(String)
    // The fields of a hash come in no order.
    const fields = (reply: unknown) => {
      const listed = flat(reply)
      return Object.fromEntries(
        listed
          .flatMap((field, index) =>
            index % 2 === 0 ? [[field, listed[index + 1]!] as const] : [],
          )
          .toSorted(([a], [b]) => a.localeCompare(b)),
      )
    }
    const read =
      type === 'hash'
        ? Effect.map(redis.send('HGETALL', key), fields)
        : type === 'zset'
          ? Effect.map(redis.send('ZRANGE', key, '0', '-1', 'WITHSCORES'), flat)
          : type === 'set'
            ? Effect.map(redis.send<string[]>('SMEMBERS', key), (members) =>
                members.toSorted(),
              )
            : redis.send<string>('GET', key)
    contents[key.slice(prefix.length + 2)] = yield* read
  }
  return contents
}, Effect.orDie)

/** A connection of its own to the server at `url`, closed with the scope. */
export const connection = (url: string) =>
  Effect.map(Layer.build(client(url)), (context) =>
    Context.get(context, Redis.Redis),
  )

/**
 * A prefix nothing else has, and so a store of its own on a server that is
 * shared. Its keys are deleted when the scope closes.
 */
export const prefixed = Effect.gen(function* () {
  const redis = yield* Redis.Redis
  const prefix = `test:${crypto.randomUUID()}:`
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const owned = yield* keys(prefix)
      for (let from = 0; from < owned.length; from += 500) {
        yield* redis.send('UNLINK', ...owned.slice(from, from + 500))
      }
    }).pipe(Effect.provideService(Redis.Redis, redis), Effect.orDie),
  )
  return prefix
})

export const fresh = Effect.fnUntraced(function* (options?: RedisOptions) {
  const prefix = yield* prefixed
  return yield* RedisStore.make({ prefix, ...options })
})

export const provided = (options?: RedisOptions) =>
  Layer.effect(Store, fresh(options))

/** The server reads its own clock, so its time passes only by waiting. */
export const harness: StoreHarness<Redis.Redis> = {
  make: (options) =>
    Effect.gen(function* () {
      let act: Effect.Effect<unknown> | undefined
      const store = yield* fresh({
        ...options,
        beforeCommit: () => {
          const pending = act
          act = undefined
          return pending ?? Effect.void
        },
      })
      return {
        store,
        // Nothing is held while a plan runs: the writer ends in the gap.
        inGap: (pending) => {
          act = pending
          return Effect.succeed(false)
        },
      }
    }),
  // A timer may fire a moment early by the clock the server reads.
  elapse: (ms) => Effect.sleep(ms + 10),
  hints: true,
  gap: true,
}

/**
 * The commands the server at `url` runs while the scope is open, those of
 * scripts included, as `MONITOR` shows them: one line each, its arguments
 * quoted. On a connection of its own, which nothing else may use.
 */
export const monitor = (url: string) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly lines: string[]; readonly socket: Net.Socket }>(
      (resume) => {
        const { hostname, port } = new URL(url)
        const socket = Net.createConnection(Number(port || 6379), hostname)
        const lines: string[] = []
        let rest = ''
        socket.on('data', (data) => {
          const read = (rest + data.toString('utf8')).split('\r\n')
          rest = read.pop()!
          for (const line of read) {
            if (line === '+OK') resume(Effect.succeed({ lines, socket }))
            else lines.push(line)
          }
        })
        socket.write('MONITOR\r\n')
      },
    ),
    ({ socket }) => Effect.sync(() => socket.destroy()),
  ).pipe(Effect.map(({ lines }) => lines))
