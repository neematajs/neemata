import type { AddressInfo, Socket } from 'node:net'
import { connect, createServer } from 'node:net'

import { PgClient } from '@effect/sql-pg'
import { describe, expect, layer } from '@effect/vitest'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'
import * as Scope from 'effect/Scope'
import * as SqlClient from 'effect/sql/SqlClient'

import * as Postgres from '../../src/postgres/index.ts'
import * as PostgresPg from '../../src/postgres/pg.ts'
import { Store } from '../../src/store.ts'
import { postgres, POSTGRES_URL } from '../postgres-support.ts'

/**
 * A database that stops answering, as a stalled server or a partition does:
 * it neither refuses nor closes a connection, and nothing it is sent is
 * answered. A store over it has to be able to stop all the same.
 */

/**
 * Stands between clients and the server at `url`. Stalled, it drops what
 * either side sends and keeps every connection open; `drop` then ends them,
 * as a partition that heals into resets does. Closed with the scope.
 */
const stalling = (url: string) =>
  Effect.gen(function* () {
    const upstream = new URL(url)
    const sockets = new Set<Socket>()
    let stalled = false
    const server = createServer((client) => {
      const service = connect(Number(upstream.port), upstream.hostname)
      for (const [from, to] of [
        [client, service],
        [service, client],
      ] as const) {
        sockets.add(from)
        from.on('data', (chunk) => {
          if (!stalled) to.write(chunk)
        })
        from.on('error', () => {})
        from.on('close', () => {
          sockets.delete(from)
          to.destroy()
        })
      }
    })
    const drop = Effect.sync(() => {
      for (const socket of sockets) socket.destroy()
    })
    const port = yield* Effect.acquireRelease(
      Effect.callback<number>((resume) => {
        server.listen(0, '127.0.0.1', () =>
          resume(Effect.succeed((server.address() as AddressInfo).port)),
        )
      }),
      () =>
        Effect.andThen(
          drop,
          Effect.sync(() => server.close()),
        ),
    )
    const proxied = new URL(url)
    proxied.hostname = '127.0.0.1'
    proxied.port = String(port)
    return {
      url: proxied.toString(),
      port,
      stall: Effect.sync(() => {
        stalled = true
      }),
      drop,
    }
  })

const options = { excludeTestServices: true, timeout: '30 seconds' } as const

/** What an effect gave and how long it took, in milliseconds. */
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now()
    const value = yield* effect
    return { value, ms: performance.now() - started }
  })

const read = (store: Store['Service']) =>
  store.transact({ runs: [crypto.randomUUID()] }, () => ({
    _tag: 'Commit' as const,
    mutation: {},
    result: undefined,
  }))

describe.skipIf(!POSTGRES_URL)('a database that stops answering', () => {
  layer(
    postgres(POSTGRES_URL!),
    options,
  )((it) => {
    /**
     * A client that reaches the database through `proxy`, on the schema of
     * the test's own, in a scope the test closes; and stores with hints over
     * it, each in a scope of its own under the client's.
     */
    const reached = Effect.fnUntraced(function* (
      proxy: Effect.Success<ReturnType<typeof stalling>>,
      config: Partial<PgClient.PgPoolConfig> = {},
    ) {
      const sql = yield* SqlClient.SqlClient
      const [{ schema }] = (yield* Effect.orDie(
        sql.unsafe<{ schema: string }>('SELECT current_schema() AS schema'),
      )) as [{ schema: string }]
      // Built apart from the test's own layers, whose `notifications`
      // would otherwise be shared and listen on the test's client.
      const memo = yield* Layer.makeMemoMap
      const scope = yield* Scope.make()
      // Closed by the test, or else here once the proxy lets nothing hang.
      yield* Effect.addFinalizer(() =>
        Effect.andThen(proxy.drop, Scope.close(scope, Exit.void)),
      )
      const client = yield* Layer.buildWithMemoMap(
        Layer.orDie(
          PgClient.layer({
            url: Redacted.make(proxy.url),
            startupParameters: { search_path: schema },
            ...config,
          }),
        ),
        memo,
        scope,
      )
      const store = Effect.gen(function* () {
        const own = yield* Scope.fork(scope)
        const built = yield* Layer.buildWithMemoMap(
          Layer.effect(
            Store,
            Postgres.make({ channel: `hints_${schema}` }),
          ).pipe(Layer.provide(PostgresPg.notifications)),
          memo,
          own,
        ).pipe(Effect.provideContext(client))
        return { scope: own, store: Context.get(built, Store) }
      })
      return { scope, sql: Context.get(client, SqlClient.SqlClient), store }
    })

    it.effect(
      'with an answer deadline, transactions fail in time and the client closes',
      () =>
        Effect.gen(function* () {
          const proxy = yield* stalling(POSTGRES_URL!)
          const deadline = 300
          const client = yield* reached(proxy, {
            stream: PostgresPg.stream({
              host: '127.0.0.1',
              port: proxy.port,
              answerTimeoutMs: deadline,
            }),
          })
          const { store } = yield* client.store
          // Answered, nothing is cut, however long it then stays idle.
          yield* read(store)
          yield* Effect.sleep(deadline * 2)
          yield* read(store)

          // `COMMIT` is never answered: the client's own statement, which the
          // store's `answerTimeoutMs` does not reach.
          const commit = yield* timed(
            Effect.flip(
              client.sql.withTransaction(
                Effect.andThen(
                  store.claimed([crypto.randomUUID()]),
                  proxy.stall,
                ),
              ),
            ),
          )
          expect(commit.value).toMatchObject({
            reason: { _tag: 'ConnectionError' },
          })
          expect(commit.ms).toBeGreaterThanOrEqual(deadline - 50)
          expect(commit.ms).toBeLessThan(deadline + 1_000)

          // Nor is `BEGIN`.
          const begin = yield* timed(Effect.flip(read(store)))
          expect(begin.value).toMatchObject({
            _tag: 'StorageError',
            cause: { reason: { _tag: 'ConnectionError' } },
          })
          expect(begin.ms).toBeLessThan(deadline + 1_000)

          // The listener's `UNLISTEN` is cut too, so nothing holds the pool's
          // close past the deadline.
          const close = yield* timed(Scope.close(client.scope, Exit.void))
          expect(close.ms).toBeLessThan(deadline + 1_000)
        }),
    )

    it.effect(
      'a store closes without waiting for UNLISTEN, which a database that answers still gets',
      () =>
        Effect.gen(function* () {
          const proxy = yield* stalling(POSTGRES_URL!)
          // One connection, so a statement after a store runs where it listened.
          const client = yield* reached(proxy, { maxConnections: 1 })
          // Answered, `UNLISTEN` goes on after the store has closed, and the
          // connection comes back without the channel.
          const answered = yield* client.store
          yield* Scope.close(answered.scope, Exit.void)
          expect(
            yield* client.sql`SELECT pg_listening_channels() AS channel`,
          ).toEqual([])

          const unanswered = yield* client.store
          yield* proxy.stall
          const close = yield* timed(Scope.close(unanswered.scope, Exit.void))
          expect(close.ms).toBeLessThan(200)

          // The client's close still waits for that connection, until it is
          // lost: here, reset.
          yield* proxy.drop
          const closed = yield* timed(Scope.close(client.scope, Exit.void))
          expect(closed.ms).toBeLessThan(1_000)
        }),
    )
  })
})
