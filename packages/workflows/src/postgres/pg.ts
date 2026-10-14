import * as Net from 'node:net'
import { Duplex } from 'node:stream'

import { PgClient } from '@effect/sql-pg'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Scope from 'effect/Scope'

import { Notifications } from './notifications.ts'

/**
 * Hints over `@effect/sql-pg`. Each store holds one connection to listen.
 *
 * Closing the store does not wait for the database to confirm `UNLISTEN`:
 * one that has stopped answering never would, and the store could not
 * close. The connection goes back to the pool once it is confirmed or lost,
 * and the pool's close waits for that as for every connection out: bound it
 * with `stream`.
 */
export const notifications: Layer.Layer<
  Notifications,
  never,
  PgClient.PgClient
> = Layer.effect(
  Notifications,
  Effect.map(Effect.service(PgClient.PgClient), (pg) => ({
    listen: (channel) =>
      Effect.acquireRelease(Scope.make(), (scope) =>
        Effect.asVoid(Effect.forkDetach(Scope.close(scope, Exit.void))),
      ).pipe(
        Effect.flatMap((scope) => Scope.provide(pg.listen(channel), scope)),
        Effect.map((queue) =>
          Effect.map(Queue.take(queue), ({ payload }) => payload),
        ),
      ),
  })),
)

export type StreamOptions = {
  /** As `PgClient`'s: `localhost` when omitted. */
  readonly host?: string
  /** As `PgClient`'s: `5432` when omitted. */
  readonly port?: number
  /** A Unix socket's path, used instead of `host` and `port` when given. */
  readonly path?: string
  /**
   * How long a connection that has sent something may hear nothing, in
   * milliseconds, before it is destroyed.
   */
  readonly answerTimeoutMs: number
}

// Node fires a longer timer after 1 ms instead.
const MAX_TIMER_MS = 2_147_483_647

/**
 * Sockets for `PgClient.layer({ ..., stream })` with a deadline for the
 * database's answer, which `@effect/sql-pg` does not have: a connection that
 * has sent something and heard nothing for `answerTimeoutMs` is destroyed,
 * and whatever waited on it fails with a `ConnectionError`. It bounds what
 * the store's `answerTimeoutMs` cannot: the `BEGIN`, `COMMIT` and `ROLLBACK`
 * of a transaction, the `UNLISTEN` of a listener, the wait for a statement
 * that was cancelled, and so the pool's close, which waits for every
 * connection out. A connection that owes nothing, idle or listening, is
 * never cut.
 *
 * It bounds the time to the first byte of an answer, and knows nothing of
 * statements: the deadline runs from a write made while nothing was owed,
 * and ends with whatever arrives first. So a statement silent for longer, as
 * one that runs or waits for a lock that long is, is cut too: choose a
 * deadline above the longest statement of the client, and above the store's
 * `answerTimeoutMs`, which cancels a statement and keeps its connection. Of
 * statements pipelined on one connection, as a `multiplex` client sends
 * them, only the first answer is waited for under it. Connecting is bounded
 * too: its first write is made before the connection is open.
 *
 * The socket is wrapped in a stream of its own for TLS, when the client asks
 * for it, to be layered over: over a bare socket TLS reads and writes past
 * what JavaScript can watch.
 */
export const stream = (options: StreamOptions): (() => Duplex) => {
  const { host = 'localhost', port = 5432, path, answerTimeoutMs } = options
  if (
    !Number.isSafeInteger(answerTimeoutMs) ||
    answerTimeoutMs <= 0 ||
    answerTimeoutMs > MAX_TIMER_MS
  ) {
    throw new RangeError(
      `answerTimeoutMs [${answerTimeoutMs}] must be a positive integer of at most ${MAX_TIMER_MS}`,
    )
  }
  return () =>
    new Answered(
      path !== undefined
        ? Net.connect({ path })
        : // As `@effect/sql-pg` connects: Nagle only holds a statement back.
          Net.connect({ host, port, noDelay: true }),
      answerTimeoutMs,
    )
}

/** A socket destroyed when it has sent something and heard nothing in time. */
class Answered extends Duplex {
  readonly #socket: Net.Socket
  readonly #answerTimeoutMs: number
  // Set while an answer is owed.
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(socket: Net.Socket, answerTimeoutMs: number) {
    super()
    this.#socket = socket
    this.#answerTimeoutMs = answerTimeoutMs
    socket.on('data', (chunk: Buffer) => {
      clearTimeout(this.#timer)
      this.#timer = undefined
      if (!this.push(chunk)) socket.pause()
    })
    socket.on('end', () => this.push(null))
    socket.on('error', (error) => this.destroy(error))
    socket.on('close', () => this.destroy())
  }

  override _read() {
    this.#socket.resume()
  }

  override _write(
    chunk: Buffer,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    // A write while an answer is owed does not put off its deadline.
    this.#timer ??= setTimeout(() => {
      const message = `PostgreSQL did not answer within ${this.#answerTimeoutMs} ms`
      this.destroy(new Error(message))
    }, this.#answerTimeoutMs)
    this.#socket.write(chunk, encoding, callback)
  }

  override _final(callback: (error?: Error | null) => void) {
    this.#socket.end(callback)
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ) {
    clearTimeout(this.#timer)
    this.#socket.destroy()
    callback(error)
  }
}
