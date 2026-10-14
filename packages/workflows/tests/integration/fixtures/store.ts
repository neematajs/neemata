import type { Store } from '@nmtjs/workflows'
import type { PostgresOptions } from '@nmtjs/workflows/postgres'
import * as NodeRedis from '@effect/platform-node/NodeRedis'
import { PgClient } from '@effect/sql-pg'
import * as Postgres from '@nmtjs/workflows/postgres'
import * as PostgresPg from '@nmtjs/workflows/postgres/pg'
import * as Redis from '@nmtjs/workflows/redis'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'

/**
 * Where one test keeps its runs, as plain data: the test process and every
 * process it spawns build the same store from it.
 */
export type StoreSpec = (
  | {
      readonly kind: 'postgres'
      readonly url: string
      readonly schema: string
      /** `false` builds a store that listens for no hints. */
      readonly hints?: boolean
      /** Connections of each store's client; 8 when omitted. */
      readonly connections?: number
    }
  | { readonly kind: 'redis'; readonly url: string; readonly prefix: string }
) & { readonly maxDeliveries?: number }

/** The channel of one schema: stores of other tests hear none of its hints. */
export const channel = (schema: string) => `hints_${schema}`

/** The PostgreSQL client of a spec, with the tables of its schema in reach. */
export const postgresClient = (
  spec: Extract<StoreSpec, { kind: 'postgres' }>,
  maxConnections = spec.connections ?? 8,
) =>
  PgClient.layer({
    url: Redacted.make(spec.url),
    startupParameters: { search_path: spec.schema },
    maxConnections,
  })

/**
 * A PostgreSQL store with the client it is built on, for code that makes
 * engine calls inside transactions of its own.
 */
export const postgresStore = (
  spec: Extract<StoreSpec, { kind: 'postgres' }>,
  options: PostgresOptions = {},
) =>
  Postgres.layer({ channel: channel(spec.schema), ...options }).pipe(
    Layer.provide(PostgresPg.notifications),
    Layer.provideMerge(postgresClient(spec)),
  )

/** The store of a spec, and nothing else of what it is built on. */
export function storeLayer(spec: StoreSpec): Layer.Layer<Store, unknown> {
  const { maxDeliveries } = spec
  const options = maxDeliveries === undefined ? {} : { maxDeliveries }
  if (spec.kind === 'redis') {
    return Redis.layer({ prefix: spec.prefix, ...options }).pipe(
      Layer.provide(NodeRedis.layer({ url: spec.url })),
    )
  }
  const store = Postgres.layer({ channel: channel(spec.schema), ...options })
  return (
    spec.hints === false
      ? store
      : Layer.provide(store, PostgresPg.notifications)
  ).pipe(Layer.provide(postgresClient(spec)))
}
