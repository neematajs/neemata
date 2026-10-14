import { PgClient } from '@effect/sql-pg'
import * as Postgres from '@nmtjs/workflows/postgres'
import * as PostgresPg from '@nmtjs/workflows/postgres/pg'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'

const schema = process.env.WORKFLOWS_SCHEMA!

/** The store every thread shares; the test installs its schema. */
export const store = Postgres.layer({ channel: `hints_${schema}` }).pipe(
  Layer.provide(PostgresPg.notifications),
  Layer.provide(
    PgClient.layer({
      url: Redacted.make(process.env.POSTGRES_URL!),
      startupParameters: { search_path: schema },
      maxConnections: 3,
    }),
  ),
)
