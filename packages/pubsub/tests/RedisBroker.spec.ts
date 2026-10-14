import EventEmitter from 'node:events'

import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Logger from 'effect/Logger'
import * as Scheduler from 'effect/Scheduler'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import type { RedisClient } from '../src/RedisBroker.ts'
import { Broker, Channel, PubSub, PubSubError } from '../src/index.ts'
import * as RedisBroker from '../src/RedisBroker.ts'

// Mirrors a Redis subscriber connection with the offline queue disabled:
// commands fail unless the connection is ready, and one in flight when the
// connection drops never settles, as the driver does not resend it.
class TestSubscriber extends EventEmitter {
  public readonly subscribed = new Set<string>()
  public subscribeCalls = 0
  public unsubscribeCalls = 0
  public disconnectCalls = 0
  public status = 'wait'
  public connectError?: Error
  public onSubscribe?: (channel: string) => unknown
  public onUnsubscribe?: (channel: string) => unknown

  async connect() {
    if (this.connectError) {
      // The driver schedules a reconnect after a failed first connect.
      this.status = 'reconnecting'
      throw this.connectError
    }
    this.status = 'ready'
  }

  async subscribe(channel: string) {
    const connection = this.assertReady()
    this.subscribeCalls++
    await this.inFlight(connection, this.onSubscribe?.(channel))
    this.subscribed.add(channel)
  }

  async unsubscribe(channel: string) {
    const connection = this.assertReady()
    this.unsubscribeCalls++
    await this.inFlight(connection, this.onUnsubscribe?.(channel))
    this.subscribed.delete(channel)
  }

  /** Drops the connection, or fails a reconnect attempt, and retries. */
  drop() {
    this.connection++
    this.subscribed.clear()
    this.status = 'reconnecting'
    process.nextTick(() => this.emit('close'))
  }

  reconnect() {
    this.status = 'ready'
    process.nextTick(() => this.emit('ready'))
  }

  disconnect() {
    this.disconnectCalls++
    // Stopped while waiting to reconnect, the driver emits nothing more.
    if (this.status !== 'ready') return
    this.drop()
    this.status = 'end'
    process.nextTick(() => this.emit('end'))
  }

  private connection = 0

  private async inFlight(connection: number, reply: unknown) {
    await reply
    if (connection !== this.connection) await new Promise(() => {})
  }

  private assertReady() {
    if (this.status !== 'ready')
      throw new Error(
        "Stream isn't writeable and enableOfflineQueue options is false",
      )
    return this.connection
  }
}

class TestClient {
  public publishError?: Error

  constructor(readonly subscriber = new TestSubscriber()) {}

  duplicate() {
    return this.subscriber
  }

  async publish(channel: string, message: string) {
    if (this.publishError) throw this.publishError
    if (
      this.subscriber.status === 'ready' &&
      this.subscriber.subscribed.has(channel)
    )
      this.subscriber.emit('message', channel, message)
    return 1
  }
}

const message: Broker.Message = { event: 'ping', payload: 1 }

const pings = Channel.make('room', { events: { ping: Schema.Number } })

const setup = Effect.gen(function* () {
  const client = new TestClient()
  // Closed by the tests that dispose the broker, and with the test otherwise.
  const scope = yield* Scope.fork(yield* Effect.scope)
  const { broker, channels, statusWaiters } = yield* RedisBroker.makeWithState(
    client as unknown as RedisClient,
  ).pipe(Scope.provide(scope))
  const pubsub = yield* PubSub.make.pipe(
    Effect.provideService(Broker.Broker, broker),
  )
  return {
    broker,
    pubsub,
    channels,
    statusWaiters,
    client,
    subscriber: client.subscriber,
    publish: (channel = 'room') => broker.publish(channel, message),
    dispose: Scope.close(scope, Exit.void),
  }
})

/** Opens a subscription in a scope of its own, closed by `release`. */
const open = (broker: Broker.Broker['Service'], channel = 'room') =>
  Effect.gen(function* () {
    const scope = yield* Scope.fork(yield* Effect.scope)
    const release = Scope.close(scope, Exit.void)
    const messages = yield* broker.subscribe(channel).pipe(
      Scope.provide(scope),
      Effect.onError(() => release),
    )
    return { messages, release }
  })

const next = <E>(messages: Stream.Stream<Broker.Message, E>) =>
  Stream.runHead(messages).pipe(
    Effect.timeoutOrElse({
      duration: 250,
      orElse: () => Effect.die(new Error('message not delivered')),
    }),
  )

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 250
    while (!predicate()) {
      if (Date.now() > deadline)
        return yield* Effect.die(new Error('condition not met'))
      yield* Effect.sleep(1)
    }
  })

const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: 250,
      orElse: () => Effect.die(new Error('did not complete')),
    }),
  )

const tick = Effect.promise(
  () => new Promise<void>((resolve) => process.nextTick(resolve)),
)

// A scheduler that suspends a fiber once it has read the connection's status
// twice, runs `interfere`, and resumes the fiber once whatever that returns has
// settled: the window in which a fiber yields between looking at the
// connection and acting on what it saw. Two reads find a ready connection
// first to wait out an outage and then again under the channel's lock, or
// find a connection that is neither ready nor ended.
function interfereAfterStatusRead(
  subscriber: TestSubscriber,
  interfere: () => Promise<void> | void,
) {
  let status = subscriber.status
  let reads = 0
  Object.defineProperty(subscriber, 'status', {
    get() {
      reads++
      return status
    },
    set(value: string) {
      status = value
    },
  })
  let holding: Promise<void> | undefined
  let happened = false
  const mixed = new Scheduler.MixedScheduler()
  const scheduler: Scheduler.Scheduler = {
    executionMode: mixed.executionMode,
    makeDispatcher: () => {
      const dispatcher = mixed.makeDispatcher()
      return {
        flush: () => dispatcher.flush(),
        scheduleTask: (task, priority) => {
          if (holding)
            void holding.then(() => dispatcher.scheduleTask(task, priority))
          else dispatcher.scheduleTask(task, priority)
        },
      }
    },
    shouldYield: (fiber) => {
      if (happened || reads !== 2) return mixed.shouldYield(fiber)
      happened = true
      holding = Promise.resolve(interfere()).then(() => {
        holding = undefined
      })
      return true
    },
  }
  return { scheduler, happened: () => happened }
}

function problems() {
  const logged: unknown[] = []
  const layer = Logger.layer([
    Logger.make<unknown, void>(({ logLevel, message }) => {
      if (logLevel === 'Warn' || logLevel === 'Error' || logLevel === 'Fatal')
        logged.push(Array.isArray(message) ? message[0] : message)
    }),
  ])
  return { logged, layer }
}

describe('RedisBroker', () => {
  it.live(
    'does not drop messages delivered as the broker subscription becomes ready',
    () =>
      Effect.gen(function* () {
        const { broker, subscriber } = yield* setup
        subscriber.onSubscribe = (channel) =>
          subscriber.emit('message', channel, JSON.stringify(message))

        const { messages } = yield* open(broker)

        expect(yield* next(messages)).toMatchObject({ value: message })
      }),
  )

  it.live('completes only once the broker subscription is live', () =>
    Effect.gen(function* () {
      const { pubsub, subscriber } = yield* setup

      const messages = yield* pubsub.subscribe(pings, undefined)
      expect(subscriber.subscribed.has('room')).toBe(true)

      yield* pubsub.publish(pings.events.ping, undefined, 1)
      expect(yield* Stream.runHead(messages).pipe(within)).toMatchObject({
        value: message,
      })
    }),
  )

  it.live('subscribes a channel once for all of its subscriptions', () =>
    Effect.gen(function* () {
      const { broker, publish, subscriber } = yield* setup
      const first = yield* open(broker)
      const second = yield* open(broker)

      yield* second.release
      yield* tick

      expect(subscriber.subscribeCalls).toBe(1)
      expect(subscriber.unsubscribeCalls).toBe(0)
      yield* publish()
      expect(yield* next(first.messages)).toMatchObject({ value: message })
    }),
  )

  it.live('releases a subscription closed before its messages are read', () =>
    Effect.gen(function* () {
      const { broker, channels, subscriber } = yield* setup
      const { release } = yield* open(broker)

      yield* release

      yield* waitFor(() => !subscriber.subscribed.has('room'))
      expect(subscriber.unsubscribeCalls).toBe(1)
      yield* waitFor(() => channels.size === 0)
    }),
  )

  it.live(
    'resubscribes for a listener that arrives while the last one unsubscribes',
    () =>
      Effect.gen(function* () {
        const { broker, publish, subscriber } = yield* setup
        const first = yield* open(broker)

        const unsubscribing = Promise.withResolvers<void>()
        subscriber.onUnsubscribe = () => unsubscribing.promise
        yield* first.release
        yield* waitFor(() => subscriber.unsubscribeCalls === 1)

        const second = yield* Effect.forkChild(open(broker))
        yield* Effect.sleep(5)
        unsubscribing.resolve()
        const { messages } = yield* Fiber.join(second)

        expect(subscriber.subscribed.has('room')).toBe(true)
        yield* publish()
        expect(yield* next(messages)).toMatchObject({ value: message })
      }),
  )

  it.live(
    'unsubscribes a channel whose only subscriber is interrupted while SUBSCRIBE is in flight',
    () =>
      Effect.gen(function* () {
        const { broker, channels, subscriber } = yield* setup
        const subscribing = Promise.withResolvers<void>()
        subscriber.onSubscribe = () => subscribing.promise

        const opening = yield* Effect.forkChild(open(broker))
        yield* waitFor(() => subscriber.subscribeCalls === 1)
        // Does not wait for the reply, which may never come.
        yield* Fiber.interrupt(opening).pipe(within)

        // The broker applies the command that was already on its way.
        subscribing.resolve()
        yield* waitFor(() => subscriber.unsubscribeCalls === 1)
        yield* waitFor(() => channels.size === 0)
        expect(subscriber.subscribed.has('room')).toBe(false)
      }),
  )

  it.live('retries SUBSCRIBE for each subscriber after one fails', () =>
    Effect.gen(function* () {
      const { broker, channels, publish, subscriber } = yield* setup
      let failures = 1
      subscriber.onSubscribe = () => {
        if (failures-- > 0) throw new Error('subscribe failed')
      }

      const [failed, succeeded] = yield* Effect.all(
        [Effect.exit(open(broker)), Effect.exit(open(broker))],
        { concurrency: 'unbounded' },
      )

      expect(Exit.isFailure(failed)).toBe(true)
      expect(subscriber.subscribeCalls).toBe(2)
      // The failed subscriber's local listener is detached, not leaked.
      expect(channels.get('room')?.listeners.size).toBe(1)

      if (!Exit.isSuccess(succeeded)) throw new Error('second open failed')
      yield* publish()
      expect(yield* next(succeeded.value.messages)).toMatchObject({
        value: message,
      })
    }),
  )

  it.live('undoes a failed SUBSCRIBE the broker may still have applied', () =>
    Effect.gen(function* () {
      const { broker, channels, subscriber } = yield* setup
      // The broker ran the command, but its reply came too late.
      const timedOut = new Error('Command timed out')
      subscriber.onSubscribe = (channel) => {
        subscriber.subscribed.add(channel)
        throw timedOut
      }

      const error = yield* Effect.flip(open(broker))

      expect(error).toBeInstanceOf(PubSubError.PubSubError)
      expect(error).toMatchObject({ cause: timedOut })
      expect(subscriber.unsubscribeCalls).toBe(1)
      yield* waitFor(() => !subscriber.subscribed.has('room'))
      yield* waitFor(() => channels.size === 0)
    }),
  )

  it.live(
    'does not wait for the UNSUBSCRIBE that undoes a failed SUBSCRIBE',
    () =>
      Effect.gen(function* () {
        const { broker, subscriber } = yield* setup
        let failures = 1
        subscriber.onSubscribe = () => {
          if (failures-- > 0) throw new Error('Command timed out')
        }
        let unanswered = 1
        subscriber.onUnsubscribe = () =>
          unanswered-- > 0 ? new Promise(() => {}) : undefined

        expect(yield* Effect.flip(open(broker)).pipe(within)).toBeInstanceOf(
          PubSubError.PubSubError,
        )
        yield* open(broker).pipe(within)
        expect(subscriber.subscribeCalls).toBe(2)
        expect(subscriber.subscribed.has('room')).toBe(true)
      }),
  )

  it.live('does not undo a SUBSCRIBE the broker rejected', () =>
    Effect.gen(function* () {
      const { broker, channels, subscriber } = yield* setup
      subscriber.onSubscribe = () => {
        const error = new Error('NOPERM no permissions to access a channel')
        error.name = 'ReplyError'
        throw error
      }

      // In the test's scope, which stays open.
      const error = yield* Effect.flip(broker.subscribe('room'))

      expect(error).toMatchObject({
        _tag: 'PubSubError',
        cause: { message: 'NOPERM no permissions to access a channel' },
      })
      expect(subscriber.unsubscribeCalls).toBe(0)
      // Released by the failure, not by its scope closing.
      yield* waitFor(() => channels.size === 0)
    }),
  )

  it.live('keeps a channel the broker refused to unsubscribe', () =>
    Effect.gen(function* () {
      const { broker, channels, publish, subscriber } = yield* setup
      const first = yield* open(broker)
      let refusals = 1
      subscriber.onUnsubscribe = () => {
        if (refusals-- === 0) return
        const error = new Error('NOPERM this user has no permissions')
        error.name = 'ReplyError'
        throw error
      }

      yield* first.release
      yield* waitFor(() => refusals === 0)
      yield* Effect.sleep(5)

      // The broker still delivers the channel, so a listener joins it as it
      // is, and the last one to leave tries the UNSUBSCRIBE again.
      const second = yield* open(broker)
      expect(subscriber.subscribeCalls).toBe(1)
      yield* publish()
      expect(yield* next(second.messages)).toMatchObject({ value: message })

      yield* second.release
      yield* waitFor(() => !subscriber.subscribed.has('room'))
      yield* waitFor(() => channels.size === 0)
    }),
  )

  it.live('fails a publish the client rejects', () =>
    Effect.gen(function* () {
      const { client, publish } = yield* setup
      client.publishError = new Error('READONLY')

      expect(yield* Effect.flip(publish())).toMatchObject({
        _tag: 'PubSubError',
        cause: client.publishError,
      })
    }),
  )

  it.live(
    'closes the subscriber connection when the layer fails to build',
    () =>
      Effect.gen(function* () {
        const client = new TestClient()
        client.subscriber.connectError = new Error('connect ECONNREFUSED')

        const error = yield* Layer.build(
          RedisBroker.layer(client as unknown as RedisClient),
        ).pipe(Effect.scoped, Effect.flip)

        expect(error).toMatchObject({
          _tag: 'PubSubError',
          cause: client.subscriber.connectError,
        })
        expect(client.subscriber.disconnectCalls).toBe(1)
      }),
  )

  it.live('ends live subscriptions cleanly when its scope closes', () => {
    const { layer, logged } = problems()
    return Effect.gen(function* () {
      const { dispose, pubsub, subscriber } = yield* setup
      const messages = yield* pubsub.subscribe(pings, undefined)
      const received: unknown[] = []
      const consumed = yield* Effect.forkChild(
        Stream.runForEach(messages, (item) =>
          Effect.sync(() => received.push(item)),
        ),
      )
      yield* pubsub.publish(pings.events.ping, undefined, 1)
      yield* waitFor(() => received.length === 1)

      yield* dispose

      expect(yield* Fiber.await(consumed).pipe(within)).toEqual(Exit.void)
      expect(received).toEqual([message])
      expect(subscriber.unsubscribeCalls).toBe(0)
      expect(subscriber.disconnectCalls).toBe(1)
      expect(logged).toEqual([])
    }).pipe(Effect.provide(layer))
  })

  describe('when the subscriber connection drops', () => {
    it.live(
      'ends established subscriptions with PubSubConnectionLostError',
      () =>
        Effect.gen(function* () {
          const { broker, channels, pubsub, subscriber } = yield* setup
          const raw = yield* open(broker)
          const messages = yield* pubsub.subscribe(pings, undefined)
          const consumed = yield* Effect.forkChild(Stream.runDrain(messages))

          subscriber.drop()

          expect(yield* Effect.flip(next(raw.messages))).toBeInstanceOf(
            PubSubError.PubSubConnectionLostError,
          )
          expect(
            yield* Fiber.join(consumed).pipe(Effect.flip, within),
          ).toBeInstanceOf(PubSubError.PubSubConnectionLostError)
          expect(channels.size).toBe(0)
          expect(subscriber.unsubscribeCalls).toBe(0)
        }),
    )

    it.live(
      'ends before delivering a backlog the subscriber has not read',
      () =>
        Effect.gen(function* () {
          const { broker, channels, publish, subscriber } = yield* setup
          const { messages } = yield* open(broker)
          for (let i = 0; i < 50; i++) yield* publish()

          subscriber.drop()
          yield* waitFor(() => channels.size === 0)

          expect(yield* Effect.flip(next(messages))).toBeInstanceOf(
            PubSubError.PubSubConnectionLostError,
          )
        }),
    )

    it.live(
      'makes a subscription opened in response to the loss wait for the reconnect',
      () =>
        Effect.gen(function* () {
          const { broker, publish, subscriber } = yield* setup
          const first = yield* open(broker, 'first')
          yield* open(broker, 'second')
          // Resumed as the loss is reported to `first`, and so possibly before
          // the broker has dealt with `second`.
          const recovery = yield* Effect.forkChild(
            Stream.runDrain(first.messages).pipe(
              Effect.catchTag('PubSubConnectionLostError', () =>
                open(broker, 'second'),
              ),
            ),
          )
          yield* Effect.sleep(5)

          subscriber.drop()
          yield* Effect.sleep(10)
          expect(recovery.pollUnsafe()).toBeUndefined()

          subscriber.reconnect()
          const recovered = yield* Fiber.join(recovery).pipe(within)
          if (!recovered) throw new Error('the first stream ended')
          yield* publish('second')
          expect(yield* next(recovered.messages)).toMatchObject({
            value: message,
          })
        }),
    )

    it.live(
      'sends no SUBSCRIBE on a connection later than the one it found ready',
      () =>
        Effect.gen(function* () {
          const { broker, channels, subscriber } = yield* setup
          // That connection drops and another is ready before the command goes.
          const interference = interfereAfterStatusRead(subscriber, () => {
            const reconnected = new Promise<void>((resolve) =>
              subscriber.once('ready', () => resolve()),
            )
            subscriber.drop()
            subscriber.reconnect()
            return reconnected
          })

          const error = yield* open(broker).pipe(
            Effect.provideService(Scheduler.Scheduler, interference.scheduler),
            Effect.flip,
            within,
          )

          expect(interference.happened()).toBe(true)
          expect(error).toBeInstanceOf(PubSubError.PubSubConnectionLostError)
          // Nothing would undo a subscription made on the new connection.
          yield* Effect.sleep(5)
          expect(subscriber.subscribeCalls).toBe(0)
          expect(subscriber.subscribed.has('room')).toBe(false)
          expect(channels.size).toBe(0)
        }),
    )

    it.live(
      'reports a connection that stops being ready before the command goes as lost',
      () => {
        const { layer, logged } = problems()
        return Effect.gen(function* () {
          const { broker, subscriber } = yield* setup
          // The driver changes status before it emits `close`.
          const interference = interfereAfterStatusRead(subscriber, () => {
            subscriber.status = 'reconnecting'
          })

          const error = yield* open(broker).pipe(
            Effect.provideService(Scheduler.Scheduler, interference.scheduler),
            Effect.flip,
            within,
          )

          expect(interference.happened()).toBe(true)
          expect(error).toBeInstanceOf(PubSubError.PubSubConnectionLostError)
          yield* Effect.sleep(5)
          expect(logged).toEqual([])
        }).pipe(Effect.provide(layer))
      },
    )

    it.live(
      'makes a listener joining a subscribed channel wait out a drop not yet reported',
      () =>
        Effect.gen(function* () {
          const { broker, publish, subscriber } = yield* setup
          yield* open(broker)

          // The driver changes status before it emits `close`.
          subscriber.status = 'reconnecting'
          const joining = yield* Effect.forkChild(open(broker))
          yield* Effect.sleep(5)
          expect(joining.pollUnsafe()).toBeUndefined()

          subscriber.subscribed.clear()
          subscriber.emit('close')
          subscriber.reconnect()
          const { messages } = yield* Fiber.join(joining).pipe(within)

          expect(subscriber.subscribeCalls).toBe(2)
          yield* publish()
          expect(yield* next(messages)).toMatchObject({ value: message })
        }),
    )

    it.live(
      'does not miss a reconnect that lands as it starts waiting for one',
      () =>
        Effect.gen(function* () {
          const { broker, publish, subscriber } = yield* setup
          subscriber.drop()
          yield* tick
          const reconnect = () => {
            subscriber.status = 'ready'
            subscriber.emit('ready')
          }
          // The connection is back between the opening finding it down and
          // starting to wait for it, if the opening can be suspended there.
          const interference = interfereAfterStatusRead(subscriber, reconnect)

          const opening = yield* Effect.forkChild(
            open(broker).pipe(
              Effect.provideService(
                Scheduler.Scheduler,
                interference.scheduler,
              ),
            ),
          )
          yield* Effect.sleep(5)
          // It could not: it was already waiting by then.
          if (!interference.happened()) reconnect()
          const { messages } = yield* Fiber.join(opening).pipe(within)

          yield* publish()
          expect(yield* next(messages)).toMatchObject({ value: message })
        }),
    )

    it.live(
      'reports the loss to a subscription first read while another learns of it',
      () =>
        Effect.gen(function* () {
          const { broker, publish, subscriber } = yield* setup
          const first = yield* open(broker, 'first')
          const second = yield* open(broker, 'second')
          yield* publish('second')
          // Resumed as the loss is reported to `first`, before the broker has
          // failed the queue that holds what `second` has not read.
          const reading = yield* Effect.forkChild(
            Stream.runDrain(first.messages).pipe(
              Effect.catchTag('PubSubConnectionLostError', () =>
                Effect.flip(next(second.messages)),
              ),
            ),
          )
          yield* Effect.sleep(5)

          subscriber.drop()

          expect(yield* Fiber.join(reading).pipe(within)).toBeInstanceOf(
            PubSubError.PubSubConnectionLostError,
          )
        }),
    )

    it.live(
      'subscribes a channel again for a listener that arrives after the reconnect',
      () =>
        Effect.gen(function* () {
          const { broker, publish, subscriber } = yield* setup
          const lost = yield* open(broker)
          subscriber.drop()
          expect(yield* Effect.flip(next(lost.messages))).toBeInstanceOf(
            PubSubError.PubSubConnectionLostError,
          )

          subscriber.reconnect()
          const { messages } = yield* open(broker)

          expect(subscriber.subscribeCalls).toBe(2)
          yield* publish()
          expect(yield* next(messages)).toMatchObject({ value: message })
        }),
    )

    it.live(
      'opens a subscription requested during an outage once the connection is back',
      () =>
        Effect.gen(function* () {
          const { broker, publish, subscriber } = yield* setup
          subscriber.drop()

          const opening = yield* Effect.forkChild(open(broker))
          // Failed reconnect attempts close the connection again.
          subscriber.drop()
          subscriber.drop()
          yield* Effect.sleep(10)
          expect(subscriber.subscribeCalls).toBe(0)

          subscriber.reconnect()
          const { messages } = yield* Fiber.join(opening)

          expect(subscriber.subscribeCalls).toBe(1)
          yield* publish()
          expect(yield* next(messages)).toMatchObject({ value: message })
        }),
    )

    it.live(
      'fails an opening subscription once the client stops reconnecting',
      () =>
        Effect.gen(function* () {
          const { broker, channels, subscriber } = yield* setup
          subscriber.drop()
          const opening = yield* Effect.forkChild(open(broker))
          yield* Effect.sleep(5)

          subscriber.status = 'end'
          subscriber.emit('end')

          expect(
            yield* Fiber.join(opening).pipe(Effect.flip, within),
          ).toBeInstanceOf(PubSubError.PubSubConnectionLostError)
          yield* waitFor(() => channels.size === 0)
        }),
    )

    it.live('fails an opening subscription whose SUBSCRIBE was in flight', () =>
      Effect.gen(function* () {
        const { broker, channels, subscriber } = yield* setup
        const subscribing = Promise.withResolvers<void>()
        subscriber.onSubscribe = () => subscribing.promise

        const opening = yield* Effect.forkChild(open(broker))
        yield* waitFor(() => subscriber.subscribeCalls === 1)
        subscriber.drop()

        expect(
          yield* Fiber.join(opening).pipe(Effect.flip, within),
        ).toBeInstanceOf(PubSubError.PubSubConnectionLostError)
        // The reply never arrives, yet the channel converges.
        yield* waitFor(() => channels.size === 0)
      }),
    )

    it.live(
      'reports a connection that closes as its SUBSCRIBE reply arrives',
      () =>
        Effect.gen(function* () {
          const { broker, channels, subscriber } = yield* setup
          // The connection closes right after the reply settles the command.
          const subscribe = subscriber.subscribe.bind(subscriber)
          subscriber.subscribe = (channel) => {
            const reply = subscribe(channel)
            void reply.then(() =>
              queueMicrotask(() => {
                subscriber.subscribed.clear()
                subscriber.status = 'reconnecting'
                subscriber.emit('close')
              }),
            )
            return reply
          }

          // Whether the opening or the stream reports it depends on which the
          // close precedes; neither may leave a subscription that looks live.
          const lost = yield* open(broker).pipe(
            Effect.flatMap(({ messages }) => next(messages)),
            Effect.flip,
            within,
          )

          expect(lost).toBeInstanceOf(PubSubError.PubSubConnectionLostError)
          yield* waitFor(() => channels.size === 0)
        }),
    )

    it.live(
      'stops waiting for the connection when an opening subscription is interrupted',
      () =>
        Effect.gen(function* () {
          const { broker, channels, statusWaiters, subscriber } = yield* setup
          subscriber.drop()

          const opening = yield* Effect.forkChild(open(broker))
          yield* waitFor(() => statusWaiters.size === 1)
          yield* Fiber.interrupt(opening)

          subscriber.reconnect()
          yield* waitFor(() => channels.size === 0)
          expect(statusWaiters.size).toBe(0)
          expect(subscriber.subscribeCalls).toBe(0)
        }),
    )

    it.live(
      'queues nothing for joins interrupted while another listener waits for the connection',
      () =>
        Effect.gen(function* () {
          const { broker, channels, publish, statusWaiters, subscriber } =
            yield* setup
          subscriber.drop()
          yield* tick
          const waiting = yield* Effect.forkChild(open(broker))
          yield* waitFor(() => statusWaiters.size === 1)

          for (let attempt = 0; attempt < 100; attempt++) {
            const opening = yield* Effect.forkChild(open(broker))
            yield* Effect.sleep(0)
            // Returns although a reconcile holds the channel's lock for as long
            // as the outage lasts.
            yield* Fiber.interrupt(opening).pipe(within)
          }

          // Releases share one queued reconcile behind the one that waits to
          // subscribe on the remaining listener's behalf, however many joins
          // left.
          const state = channels.get('room')!
          expect(state.listeners.size).toBe(1)
          expect(state.users).toBeLessThanOrEqual(2)
          expect(statusWaiters.size).toBeLessThanOrEqual(2)

          subscriber.reconnect()
          const { messages } = yield* Fiber.join(waiting)
          expect(subscriber.subscribeCalls).toBe(1)
          yield* publish()
          expect(yield* next(messages)).toMatchObject({ value: message })
        }),
    )

    it.live('releases without UNSUBSCRIBE before the drop is reported', () => {
      const { layer, logged } = problems()
      return Effect.gen(function* () {
        const { broker, channels, subscriber } = yield* setup
        const { messages, release } = yield* open(broker)

        // The driver changes status before it emits `close`.
        subscriber.status = 'reconnecting'
        yield* release

        expect(yield* next(messages)).toMatchObject({ _tag: 'None' })
        yield* waitFor(() => channels.size === 0)
        expect(subscriber.unsubscribeCalls).toBe(0)
        // Nor a command attempted that could only fail.
        expect(logged).toEqual([])
      }).pipe(Effect.provide(layer))
    })

    it.live('drains a channel whose listeners all leave during an outage', () =>
      Effect.gen(function* () {
        const { broker, channels, statusWaiters, subscriber } = yield* setup
        subscriber.drop()
        yield* tick
        const remaining = yield* Effect.forkChild(open(broker))
        yield* waitFor(() => statusWaiters.size === 1)
        // Its release finds the other listener still wanting the channel, and
        // waits for the connection on its behalf, holding the channel's lock.
        const leaving = yield* Effect.forkChild(open(broker))
        yield* Effect.sleep(0)
        yield* Fiber.interrupt(leaving)
        yield* waitFor(() => statusWaiters.size === 2)

        yield* Fiber.interrupt(remaining)

        yield* waitFor(() => channels.size === 0)
        expect(statusWaiters.size).toBe(0)
        subscriber.reconnect()
        yield* Effect.sleep(10)
        expect(subscriber.subscribeCalls).toBe(0)
      }),
    )

    it.live('closes its scope without waiting for the connection', () => {
      const { layer, logged } = problems()
      return Effect.gen(function* () {
        const { broker, dispose, subscriber } = yield* setup
        subscriber.onSubscribe = (channel) =>
          channel === 'lobby' ? new Promise(() => {}) : undefined
        const inFlight = yield* Effect.forkChild(open(broker, 'lobby'))
        yield* waitFor(() => subscriber.subscribeCalls === 1)
        subscriber.status = 'reconnecting'
        const waiting = yield* Effect.forkChild(open(broker))
        yield* Effect.sleep(5)

        yield* dispose.pipe(within)

        for (const fiber of [inFlight, waiting]) {
          const exit = yield* Fiber.await(fiber).pipe(within)
          expect(Exit.hasInterrupts(exit)).toBe(true)
        }
        expect(logged).toEqual([])
      }).pipe(Effect.provide(layer))
    })
  })
})
