import type * as Scope from 'effect/Scope'
import type { Redis } from 'ioredis'
import type { Redis as Valkey } from 'iovalkey'
import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FiberSet from 'effect/FiberSet'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import type { Message } from './Broker.ts'
import { Broker } from './Broker.ts'
import { PubSubConnectionLostError, PubSubError } from './PubSubError.ts'

export type RedisClient = Redis | Valkey

// Fails when its connection closes: the driver never settles a command that
// was in flight then, as it does not resend it after the reconnect.
type Connection = Deferred.Deferred<never, PubSubConnectionLostError>

type Listener = {
  readonly queue: Queue.Queue<Message, PubSubConnectionLostError | Cause.Done>
  // Set as its connection closes, before its queue is failed.
  lost?: PubSubConnectionLostError
  // Its channel was subscribed on the current connection when it joined, so
  // that connection closing ends it.
  established: boolean
}

type ChannelState = {
  readonly listeners: Set<Listener>
  // Only ever true while the current connection is subscribed: a connection
  // resets it as it closes, before anything else can observe the channel.
  subscribed: boolean
  // SUBSCRIBE and UNSUBSCRIBE run one at a time and each converges the broker
  // on the listeners at the moment it runs, so a listener arriving while the
  // last one leaves is never left on a channel the broker dropped.
  readonly lock: Semaphore.Semaphore
  // Fibers holding or awaiting the lock, which the channel map must not
  // forget: a second state for the channel would have a second lock.
  users: number
  // Ends the wait for the connection when the last listener leaves, so the
  // releases queued behind a SUBSCRIBE drain during an outage.
  wake?: () => void
  // A release reconcile is queued and has not started. It converges on the
  // listeners when it runs, so later releases need not queue another.
  releasing: boolean
}

/**
 * The broker together with the bookkeeping its tests check for leaks.
 *
 * @internal
 */
export const makeWithState = (client: RedisClient) =>
  Effect.gen(function* () {
    const channels = new Map<string, ChannelState>()
    // Kept apart from the client's own listeners so an interrupted wait
    // leaves nothing behind during an outage.
    const statusWaiters = new Set<() => void>()
    let connection: Connection = Deferred.makeUnsafe()
    let closed = false

    // The driver's callbacks run outside any fiber.
    const runFork = Effect.runForkWith(yield* Effect.context<never>())
    // Reconciles outlive the subscription that asked for them. Made before
    // the subscriber so they are interrupted after it stops accepting work.
    const reconciles = yield* FiberSet.make<void, unknown>()

    const onMessage = (channel: string, raw: string) => {
      const listeners = channels.get(channel)?.listeners
      if (!listeners || listeners.size === 0) return
      let message: Message
      try {
        message = JSON.parse(raw)
      } catch (cause) {
        runFork(
          Effect.logError('Failed to parse pubsub message', cause).pipe(
            Effect.annotateLogs({ channel }),
          ),
        )
        return
      }
      for (const { queue } of listeners) Queue.offerUnsafe(queue, message)
    }

    const onStatus = () => {
      for (const settle of statusWaiters) settle()
    }

    // Emitted on every drop, including each failed reconnect attempt, before
    // the next connection is ready.
    const onClose = () => {
      const error = new PubSubConnectionLostError()
      const closing = connection
      connection = Deferred.makeUnsafe()

      // Completing a deferred or a queue resumes whoever waits on it there
      // and then, and that code may subscribe again. Every channel is reset
      // first, so it finds none still marked subscribed on this connection.
      const lost: Listener[] = []
      const idle: ChannelState[] = []
      for (const [channel, state] of channels) {
        // The broker dropped every subscription with the connection.
        state.subscribed = false
        // Subscriptions still opening are left alone: they subscribe once the
        // connection is back, so an outage does not fail them on every attempt.
        for (const listener of state.listeners) {
          if (!listener.established) continue
          state.listeners.delete(listener)
          listener.lost = error
          lost.push(listener)
        }
        if (state.listeners.size === 0) idle.push(state)
        forget(channel, state)
      }

      Deferred.doneUnsafe(closing, Exit.fail(error))
      for (const { queue } of lost) {
        // The loss goes ahead of the unread backlog: the subscriber refetches
        // anyway, and a slow reader would otherwise learn of the gap only
        // after all of it.
        Queue.failCauseUnsafe(queue, Cause.fail(error))
        Queue.shutdownUnsafe(queue)
      }
      for (const state of idle) if (state.listeners.size === 0) state.wake?.()
      if (lost.length > 0)
        runFork(
          Effect.logWarning('Subscriber connection lost').pipe(
            Effect.annotateLogs({ subscriptions: lost.length }),
          ),
        )
    }

    // Redis requires a dedicated connection for pub/sub. The broker recovers
    // from a drop itself: resubscribing silently would hide the gap
    // subscribers must recover, and a command queued or resent for a later
    // connection would leave the broker out of step with the channel map, so
    // commands are only sent on a ready connection.
    const subscriber = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const subscriber = client.duplicate({
          lazyConnect: true,
          autoResubscribe: false,
          autoResendUnfulfilledCommands: false,
          enableOfflineQueue: false,
        })
        subscriber.on('message', onMessage)
        subscriber.on('close', onClose)
        subscriber.on('ready', onStatus)
        subscriber.on('end', onStatus)
        return subscriber
      }),
      (subscriber) =>
        Effect.sync(() => {
          // Detached first, so closing ends subscriptions as finished rather
          // than as lost to the connection it closes.
          subscriber.off('message', onMessage)
          subscriber.off('close', onClose)
          subscriber.off('ready', onStatus)
          subscriber.off('end', onStatus)
          closed = true
          for (const state of channels.values())
            for (const { queue } of state.listeners) Queue.endUnsafe(queue)
          channels.clear()
          onStatus()
          // Unlike QUIT, this also stops a pending reconnect, and a
          // subscriber connection has no replies worth waiting for.
          subscriber.disconnect()
        }),
    )

    // The driver keeps reconnecting after a failed first connect; failing
    // here closes the scope, which disconnects it.
    yield* Effect.tryPromise({
      try: () => subscriber.connect(),
      catch: (cause) => new PubSubError({ cause }),
    })

    const channelState = (channel: string): ChannelState => {
      let state = channels.get(channel)
      if (!state) {
        state = {
          listeners: new Set(),
          subscribed: false,
          lock: Semaphore.makeUnsafe(1),
          users: 0,
          releasing: false,
        }
        channels.set(channel, state)
      }
      return state
    }

    const forget = (channel: string, state: ChannelState) => {
      if (
        state.users === 0 &&
        state.listeners.size === 0 &&
        !state.subscribed &&
        channels.get(channel) === state
      )
        channels.delete(channel)
    }

    /**
     * Waits out a reconnect, and fails once the client stops reconnecting.
     * Yields nothing if `state` loses its last listener first.
     */
    const connected = (state?: ChannelState) =>
      Effect.callback<Connection | undefined, PubSubConnectionLostError>(
        (resume) => {
          const settled = () => {
            if (closed) return Effect.interrupt
            if (state?.listeners.size === 0) return Effect.succeed(undefined)
            if (subscriber.status === 'ready') return Effect.succeed(connection)
            if (subscriber.status === 'end')
              return Effect.fail(new PubSubConnectionLostError())
          }
          const detach = () => {
            statusWaiters.delete(settle)
            if (state?.wake === settle) state.wake = undefined
          }
          const settle = () => {
            const result = settled()
            if (!result) return
            detach()
            resume(result)
          }
          // Checked and registered in one step: a status change in between
          // would otherwise wake nobody.
          const result = settled()
          if (result) return resume(result)
          statusWaiters.add(settle)
          if (state) state.wake = settle
          return Effect.sync(detach)
        },
      )

    const send = (command: () => Promise<unknown>, sendOn: Connection) =>
      Effect.raceFirst(
        Effect.tryPromise({
          try: () => {
            // Checked as the command is handed to the driver. The fiber may
            // have yielded since it found this connection ready, and a
            // command sent on a later one would outlive the failure reported
            // for this one, which nothing would then undo.
            if (connection !== sendOn || subscriber.status !== 'ready')
              throw new PubSubConnectionLostError()
            return command()
          },
          catch: (cause) =>
            cause instanceof PubSubConnectionLostError
              ? cause
              : new PubSubError({ cause }),
        }),
        Deferred.await(sendOn),
      )

    const reconcile = (channel: string, state: ChannelState) =>
      Effect.gen(function* () {
        if (closed) {
          state.subscribed = false
        } else if (state.listeners.size > 0 && !state.subscribed) {
          const ready = yield* connected(state)
          // The last listener may have left while the connection was down.
          if (!ready || state.listeners.size === 0) return
          yield* send(() => subscriber.subscribe(channel), ready).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                // A SUBSCRIBE that failed without a broker reply, at
                // `commandTimeout` say, may still reach the broker. An
                // UNSUBSCRIBE sent after it on the same connection is
                // processed after it, and before any later SUBSCRIBE, so it
                // is sent here, under the lock, and not awaited.
                if (
                  error._tag !== 'PubSubError' ||
                  connection !== ready ||
                  isReplyError(error.cause)
                )
                  return
                subscriber.unsubscribe(channel).catch((cause) => {
                  if (connection === ready && !closed)
                    runFork(
                      Effect.logWarning(
                        'Failed to undo a failed SUBSCRIBE',
                        cause,
                      ).pipe(Effect.annotateLogs({ channel })),
                    )
                })
              }),
            ),
          )
          // The connection may have closed between the reply and this
          // fiber resuming, should the fiber yield to the scheduler; checked
          // here, with nothing in between, so the channel is never marked
          // subscribed on a connection that already closed.
          if (connection !== ready)
            return yield* new PubSubConnectionLostError()
          state.subscribed = true
          yield* Effect.logDebug('Subscribed channel').pipe(
            Effect.annotateLogs({ channel, listeners: state.listeners.size }),
          )
        } else if (state.listeners.size === 0 && state.subscribed) {
          state.subscribed = false
          // Status changes before the close event is emitted. A connection
          // that is down already dropped the subscription, and the command
          // could only fail.
          if (subscriber.status !== 'ready') return
          const sentOn = connection
          yield* send(() => subscriber.unsubscribe(channel), sentOn).pipe(
            Effect.andThen(() =>
              Effect.logDebug('Unsubscribed channel').pipe(
                Effect.annotateLogs({ channel }),
              ),
            ),
            Effect.catchTags({
              // Losing the connection drops the subscription anyway.
              PubSubConnectionLostError: () => Effect.void,
              PubSubError: (error) => {
                // The broker refused, so the channel is still subscribed: a
                // later listener joins it as it is, and the last to leave
                // tries again. Any other failure may yet take effect, and
                // assuming it did only costs a redundant SUBSCRIBE, where
                // assuming it did not would leave a listener on a channel the
                // broker dropped.
                if (isReplyError(error.cause) && connection === sentOn)
                  state.subscribed = true
                return Effect.logWarning(
                  'Failed to unsubscribe channel',
                  error.cause,
                ).pipe(Effect.annotateLogs({ channel }))
              },
            }),
          )
        }
      })

    const locked = <E>(
      channel: string,
      state: ChannelState,
      effect: Effect.Effect<void, E>,
    ) =>
      Effect.acquireUseRelease(
        Effect.sync(() => state.users++),
        () => state.lock.withPermits(1)(effect),
        () =>
          Effect.sync(() => {
            state.users--
            forget(channel, state)
          }),
      )

    const release = (
      channel: string,
      state: ChannelState,
      listener: Listener,
    ) =>
      Effect.suspend(() => {
        Queue.endUnsafe(listener.queue)
        Queue.shutdownUnsafe(listener.queue)
        // A lost connection already removed the listener.
        if (!state.listeners.delete(listener) || closed) return Effect.void
        if (state.listeners.size === 0) state.wake?.()
        if (state.releasing) return Effect.void
        state.releasing = true
        // Not awaited: the reconcile can queue behind a SUBSCRIBE that waits
        // for the connection to come back. A SUBSCRIBE it issues is on behalf
        // of a remaining listener, whose own reconcile retries it and reports
        // the failure.
        return FiberSet.run(
          reconciles,
          locked(
            channel,
            state,
            Effect.suspend(() => {
              state.releasing = false
              return reconcile(channel, state)
            }),
          ).pipe(Effect.ignore),
        )
      })

    const subscribe: Broker['Service']['subscribe'] = (channel) =>
      Effect.gen(function* () {
        const listener: Listener = {
          queue: yield* Queue.unbounded<
            Message,
            PubSubConnectionLostError | Cause.Done
          >(),
          established: false,
        }
        // Attached before the broker confirms SUBSCRIBE; otherwise a message
        // delivered right after it becomes ready could be dropped.
        const state = yield* Effect.acquireRelease(
          Effect.suspend(() => {
            if (closed) return Effect.interrupt
            const state = channelState(channel)
            state.listeners.add(listener)
            return Effect.succeed(state)
          }),
          (state) => release(channel, state, listener),
        )
        yield* Effect.gen(function* () {
          // A channel already subscribed needs no command, unless its
          // connection is about to report that it closed.
          if (!state.subscribed || subscriber.status !== 'ready') {
            // Waits out an outage before queueing, so an opening interrupted
            // meanwhile leaves nothing behind a lock another listener's
            // SUBSCRIBE holds.
            yield* connected()
            // Interrupting the wait leaves the reconcile running: the command
            // may already have reached the broker, and the release queued
            // behind it converges the channel on whatever it achieved.
            const opening = yield* FiberSet.run(
              reconciles,
              locked(channel, state, reconcile(channel, state)),
            )
            yield* Fiber.join(opening)
          }
          // A connection that closed since reset this, and did not end the
          // listener, which was not established yet.
          if (!state.subscribed) return yield* new PubSubConnectionLostError()
          listener.established = true
          // A failed opening releases at once, not when the scope closes.
        }).pipe(Effect.onError(() => release(channel, state, listener)))
        return Stream.fromQueue(listener.queue).pipe(
          // Queues are failed one after another, each resuming its consumer
          // there and then, and that consumer may read a subscription whose
          // queue still holds its backlog.
          Stream.mapArrayEffect((messages) =>
            listener.lost
              ? Effect.fail(listener.lost)
              : Effect.succeed(messages),
          ),
        )
      })

    const broker = Broker.of({
      publish: (channel, message) =>
        Effect.asVoid(
          Effect.tryPromise({
            try: () => client.publish(channel, JSON.stringify(message)),
            catch: (cause) => new PubSubError({ cause }),
          }),
        ),
      subscribe,
    })
    return { broker, channels, statusWaiters }
  })

/**
 * Shares one subscriber connection across channels and subscribes to each
 * channel once, however many local subscriptions it has. The client must
 * already be connected and outlive the scope.
 */
export const make = (
  client: RedisClient,
): Effect.Effect<Broker['Service'], PubSubError, Scope.Scope> =>
  Effect.map(makeWithState(client), ({ broker }) => broker)

// The broker answered the command, so it did not and will not take effect.
function isReplyError(error: unknown) {
  return error instanceof Error && error.name === 'ReplyError'
}

/**
 * Does not manage the client's connection: build the client in a layer of
 * its own, and provide it so that it outlives this one.
 */
export const layer = (client: RedisClient): Layer.Layer<Broker, PubSubError> =>
  Layer.effect(Broker, make(client))
