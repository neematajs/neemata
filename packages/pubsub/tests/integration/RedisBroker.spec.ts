import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Logger from 'effect/Logger'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import type { RedisClient } from '../../src/RedisBroker.ts'
import type { ServiceTarget } from './helpers.ts'
import { Broker, Channel, PubSub, PubSubError } from '../../src/index.ts'
import * as RedisBroker from '../../src/RedisBroker.ts'
import {
  createTestName,
  requireServiceEnv,
  serviceTargets,
  trafficGate,
  waitFor,
} from './helpers.ts'

const clientOf = (
  target: ServiceTarget,
  options?: Parameters<ServiceTarget['createClient']>[0],
) =>
  Effect.acquireRelease(
    Effect.sync(() => target.createClient(options)),
    (client) => Effect.promise(() => client.quit().catch(() => undefined)),
  )

// Acquired after its client, so it is released before the client quits.
const pubsubOf = (client: RedisClient) =>
  Effect.gen(function* () {
    const broker = yield* RedisBroker.make(client)
    const pubsub = yield* PubSub.make.pipe(
      Effect.provideService(Broker.Broker, broker),
    )
    return { broker, pubsub }
  })

const subscribers = (client: RedisClient, channel: string) => async () => {
  const [, count] = (await client.call('PUBSUB', 'NUMSUB', channel)) as [
    string,
    number,
  ]
  return Number(count)
}

const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: 5000,
      orElse: () => Effect.die(new Error('did not complete')),
    }),
  )

for (const target of serviceTargets) {
  requireServiceEnv(target)

  describe.skipIf(!target.url)(
    `@nmtjs/pubsub ${target.name} integration`,
    () => {
      it.live(
        'publishes typed events to the subscribers of every process',
        () =>
          Effect.gen(function* () {
            const name = createTestName('pubsub')
            const room = Channel.make(name, {
              params: Schema.Struct({ id: Schema.String }),
              key: ({ id }) => id,
              events: {
                seen: Schema.DateTimeUtcFromString,
                message: Schema.Struct({ text: Schema.String }),
              },
            })
            const clientA = yield* clientOf(target)
            const a = yield* pubsubOf(clientA)
            const b = yield* pubsubOf(yield* clientOf(target))
            const at = Schema.decodeSync(Schema.DateTimeUtcFromString)(
              '2026-01-01T00:00:00.000Z',
            )

            const [streamA, streamB] = yield* Effect.all(
              [
                a.pubsub.subscribe(room, { id: 'room-1' }),
                b.pubsub.subscribe(room, { id: 'room-1' }),
              ],
              { concurrency: 'unbounded' },
            )
            expect(
              yield* Effect.promise(subscribers(clientA, `${name}:room-1`)),
            ).toBe(2)

            yield* a.pubsub.publish(
              room.events.message,
              { id: 'room-1' },
              { text: 'hello' },
            )
            yield* b.pubsub.publish(room.events.seen, { id: 'room-1' }, at)

            const expected = [
              { event: 'message', payload: { text: 'hello' } },
              { event: 'seen', payload: at },
            ]
            for (const stream of [streamA, streamB])
              expect(
                yield* Stream.runCollect(Stream.take(stream, 2)).pipe(within),
              ).toEqual(expected)
          }),
      )

      it.live(
        'delivers a message published as soon as subscribe completes',
        () =>
          Effect.gen(function* () {
            const pings = Channel.make(createTestName('pubsub-ready'), {
              events: { ping: Schema.Number },
            })
            const { pubsub } = yield* pubsubOf(yield* clientOf(target))

            const messages = yield* pubsub.subscribe(pings, undefined)
            yield* pubsub.publish(pings.events.ping, undefined, 1)

            expect(yield* Stream.runHead(messages).pipe(within)).toMatchObject({
              value: { event: 'ping', payload: 1 },
            })
          }),
      )

      it.live(
        'ends live subscriptions cleanly when the broker scope closes',
        () => {
          const logged: unknown[] = []
          const problems = Logger.layer([
            Logger.make<unknown, void>(({ logLevel, message }) => {
              if (logLevel === 'Warn' || logLevel === 'Error')
                logged.push(message)
            }),
          ])
          return Effect.gen(function* () {
            const pings = Channel.make(createTestName('pubsub-dispose'), {
              events: { ping: Schema.Number },
            })
            const client = yield* clientOf(target)
            const scope = yield* Scope.fork(yield* Effect.scope)
            const { pubsub } = yield* pubsubOf(client).pipe(
              Scope.provide(scope),
            )

            const messages = yield* pubsub.subscribe(pings, undefined)
            const received: unknown[] = []
            const consumed = yield* Effect.forkChild(
              Stream.runForEach(messages, (item) =>
                Effect.sync(() => received.push(item)),
              ),
            )
            yield* pubsub.publish(pings.events.ping, undefined, 1)
            yield* waitFor(() => received.length === 1)

            yield* Scope.close(scope, Exit.void)

            expect(yield* Fiber.await(consumed).pipe(within)).toEqual(Exit.void)
            expect(received).toEqual([{ event: 'ping', payload: 1 }])
            expect(logged).toEqual([])
          }).pipe(Effect.provide(problems))
        },
      )

      it.live(
        'ends established subscriptions when the subscriber connection is killed, and subscribes again after the reconnect',
        () =>
          Effect.gen(function* () {
            const pings = Channel.make(createTestName('pubsub-killed'), {
              events: { ping: Schema.Number },
            })
            const client = yield* clientOf(target)
            const { broker, pubsub } = yield* pubsubOf(client)

            const raw = yield* broker.subscribe(pings.name)
            const messages = yield* pubsub.subscribe(pings, undefined)
            const ended = yield* Effect.forkChild(
              Effect.all(
                [
                  Effect.flip(Stream.runDrain(raw)),
                  Effect.flip(Stream.runDrain(messages)),
                ],
                { concurrency: 'unbounded' },
              ),
            )
            yield* Effect.sleep(20)

            yield* Effect.promise(() =>
              client.call('CLIENT', 'KILL', 'TYPE', 'pubsub'),
            )
            for (const error of yield* Fiber.join(ended).pipe(within))
              expect(error).toBeInstanceOf(
                PubSubError.PubSubConnectionLostError,
              )

            // Completes once the connection is back and the channel subscribed.
            const resubscribed = yield* pubsub.subscribe(pings, undefined)
            yield* pubsub.publish(pings.events.ping, undefined, 1)
            expect(
              yield* Stream.runHead(resubscribed).pipe(within),
            ).toMatchObject({ value: { event: 'ping', payload: 1 } })
          }),
      )

      it.live(
        'leaves no broker subscription behind a SUBSCRIBE that timed out',
        () =>
          Effect.gen(function* () {
            const channel = createTestName('pubsub-timed-out')
            const gate = yield* trafficGate(target.url!)
            const admin = yield* clientOf(target)
            const { broker } = yield* pubsubOf(
              yield* clientOf(target, { commandTimeout: 150, url: gate.url }),
            )

            // The SUBSCRIBE reaches the broker only after it timed out, and is
            // then run.
            gate.hold()
            const error = yield* Effect.flip(
              Effect.scoped(broker.subscribe(channel)),
            ).pipe(Effect.ensuring(Effect.sync(() => gate.release())))
            expect(error).toMatchObject({
              _tag: 'PubSubError',
              cause: { message: expect.stringMatching(/timed out/i) },
            })
            // The broker ran the late SUBSCRIBE, so NUMSUB can't read 0 before
            // it.
            yield* waitFor(() =>
              gate
                .received()
                .includes(
                  `$9\r\nsubscribe\r\n$${channel.length}\r\n${channel}\r\n`,
                ),
            )

            yield* waitFor(
              async () => (await subscribers(admin, channel)()) === 0,
            )
          }),
      )

      it.live(
        'delivers the selected events and unsubscribes when the stream ends',
        () =>
          Effect.gen(function* () {
            const name = createTestName('pubsub-filter')
            const room = Channel.make(name, {
              params: Schema.Struct({ id: Schema.String }),
              key: ({ id }) => id,
              events: {
                message: Schema.Struct({ text: Schema.String }),
                typing: Schema.Struct({ userId: Schema.String }),
              },
            })
            const client = yield* clientOf(target)
            const { pubsub } = yield* pubsubOf(client)
            const count = subscribers(client, `${name}:room-1`)

            const messages = yield* pubsub.subscribe(
              room,
              { id: 'room-1' },
              { message: true },
            )
            expect(yield* Effect.promise(count)).toBe(1)

            yield* pubsub.publish(
              room.events.typing,
              { id: 'room-1' },
              { userId: 'u1' },
            )
            yield* pubsub.publish(
              room.events.message,
              { id: 'room-1' },
              { text: 'visible' },
            )

            expect(yield* Stream.runHead(messages).pipe(within)).toMatchObject({
              value: { event: 'message', payload: { text: 'visible' } },
            })
            // The scope the subscription was opened in is still open.
            yield* waitFor(async () => (await count()) === 0)
          }),
      )

      it.live(
        'skips unknown and invalid broker messages before delivering valid events',
        () =>
          Effect.gen(function* () {
            const name = createTestName('pubsub-noise')
            const room = Channel.make(name, {
              params: Schema.Struct({ id: Schema.String }),
              key: ({ id }) => id,
              events: { message: Schema.Struct({ text: Schema.String }) },
            })
            const client = yield* clientOf(target)
            const { pubsub } = yield* pubsubOf(client)
            const channel = `${name}:room-1`

            const messages = yield* pubsub.subscribe(room, { id: 'room-1' })
            yield* Effect.promise(async () => {
              await client.publish(channel, 'not json')
              await client.publish(channel, 'null')
              await client.publish(
                channel,
                JSON.stringify({
                  event: 'missing',
                  payload: { text: 'ignored' },
                }),
              )
              await client.publish(
                channel,
                JSON.stringify({ event: 'message', payload: { text: 123 } }),
              )
            })
            yield* pubsub.publish(
              room.events.message,
              { id: 'room-1' },
              { text: 'visible' },
            )

            expect(yield* Stream.runHead(messages).pipe(within)).toMatchObject({
              value: { event: 'message', payload: { text: 'visible' } },
            })
          }),
      )
    },
  )
}
