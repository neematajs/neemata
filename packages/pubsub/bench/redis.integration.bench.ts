import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'
import { test } from 'vitest'

import type { RedisClient } from '../src/RedisBroker.ts'
import { Broker, Channel, PubSub } from '../src/index.ts'
import * as RedisBroker from '../src/RedisBroker.ts'
import {
  createTestName,
  requireServiceEnv,
  serviceTargets,
  waitFor,
} from '../tests/integration/helpers.ts'

const benchmarkOptions = {
  iterations: 500,
  time: 0,
  warmupIterations: 100,
  warmupTime: 0,
}
const messagesPerSample = 20

for (const target of serviceTargets) {
  requireServiceEnv(target)

  test.skipIf(!target.url)(
    `${target.name} PubSub round trip`,
    async ({ bench }) => {
      const channelName = createTestName('pubsub-benchmark')
      const channel = Channel.make(channelName, {
        params: Schema.Struct({ id: Schema.String }),
        key: ({ id }) => id,
        events: { message: Schema.Struct({ text: Schema.String }) },
      })
      const params = { id: 'room-1' }
      const payload = { text: 'benchmark' }
      let client: RedisClient | undefined
      let scope: Scope.Closeable | undefined
      let pubsub: PubSub.PubSub['Service'] | undefined
      // Settle the pending round trip: on the next message, or when the
      // consumer stops, so a dead stream fails the benchmark rather than
      // hanging it.
      let received: (() => void) | undefined
      let stopped: ((error: Error) => void) | undefined
      let ended: Error | undefined

      const roundTrip = async () => {
        if (ended) throw ended
        const arrived = new Promise<void>((resolve, reject) => {
          received = resolve
          stopped = reject
        })
        // Awaited together, so either failure ends the round trip and
        // neither goes unhandled.
        await Promise.all([
          Effect.runPromise(
            pubsub!.publish(channel.events.message, params, payload),
          ),
          arrived,
        ])
      }

      async function setup() {
        if (scope) return

        try {
          client = target.createClient()
          scope = Effect.runSync(Scope.make())
          await Effect.runPromise(
            Effect.gen(function* () {
              const broker = yield* RedisBroker.make(client!)
              pubsub = yield* PubSub.make.pipe(
                Effect.provideService(Broker.Broker, broker),
              )
              const messages = yield* pubsub.subscribe(channel, params)
              yield* Effect.forkIn(
                Stream.runForEach(messages, () =>
                  Effect.sync(() => received?.()),
                ).pipe(
                  Effect.onExit((exit) =>
                    Effect.sync(() => {
                      ended = new Error('PubSub benchmark stream ended', {
                        cause: exit,
                      })
                      stopped?.(ended)
                    }),
                  ),
                ),
                scope!,
              )
              yield* waitFor(async () => {
                const result = await client!.pubsub(
                  'NUMSUB',
                  `${channelName}:${params.id}`,
                )
                return Number(result[1] ?? 0) === 1
              })
            }).pipe(Scope.provide(scope)),
          )
          await roundTrip()
        } catch (error) {
          await teardown()
          throw error
        }
      }

      async function teardown() {
        if (scope) await Effect.runPromise(Scope.close(scope, Exit.void))
        await client?.quit()
        client = undefined
        scope = undefined
        pubsub = undefined
        received = undefined
        stopped = undefined
        ended = undefined
      }

      // Tinybench skips afterAll hooks when an iteration throws.
      try {
        await bench(
          `publishes and receives ${messagesPerSample} messages`,
          { beforeAll: setup },
          async () => {
            for (let index = 0; index < messagesPerSample; index++)
              await roundTrip()
          },
        ).run(benchmarkOptions)
      } finally {
        await teardown()
      }
    },
  )
}
