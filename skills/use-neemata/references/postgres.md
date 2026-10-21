# PostgreSQL workflows

`@nmtjs/workflows/postgres` is a `Store` on Effect SQL. It depends on
`SqlClient` alone, so `@effect/sql-pg` and `@effect/sql-pglite` share one code
path. Exports: `layer`, `make`, `install`, `verify`, `migrateFrom6`,
`MIGRATION_FROM_6`, `MIGRATION_FROM_6_SQL`, `migrateFrom4`,
`MIGRATION_FROM_4`, `MIGRATION_FROM_4_SQL`, `SCHEMA_VERSION` (7), `CHANNEL`
and `Notifications`.

## Store layer

```ts
import { PgClient } from '@effect/sql-pg'
import * as Postgres from '@nmtjs/workflows/postgres'
import * as PostgresPg from '@nmtjs/workflows/postgres/pg'
import * as Layer from 'effect/Layer'
import * as Redacted from 'effect/Redacted'

const database = PgClient.layer({
  url: Redacted.make(process.env.DATABASE_URL!),
})

export const store = Postgres.layer({ maxDeliveries: 20 }).pipe(
  // Optional: without it workers find work by polling alone.
  Layer.provide(PostgresPg.notifications),
  Layer.provide(database),
)
```

- Build the client without name transforms; the adapter is written for the
  default `READ COMMITTED` isolation.
- Options: `maxDeliveries` (20), `channel` (`workflow_hints`, 1 to 63
  bytes), `answerTimeoutMs` (none). Invalid options make the layer die.
- `answerTimeoutMs` cancels a statement the database has not answered in
  time, including one waiting on another transaction's guard; the operation
  fails with `StorageError` (cause: `SqlError` with `StatementTimeoutError`).
  For `claim`, `release` and `renew` the outcome is then unknown. Transaction
  begin/commit statements are the client's: bound them with client or server
  settings.
- Hints use `LISTEN` on one channel per database. Stores in two schemas of
  one database hear each other's hints unless given different `channel`s;
  that costs needless claims, not correctness. Use
  `PostgresPglite.notifications` from `/postgres/pglite` on PGlite.
- Processes that start runs and workers of one deployment must use the same
  database and schema, and the same `channel` for their hints to reach the
  workers.

For tests and local development, PGlite runs PostgreSQL in the process:

```ts
import { PgliteClient } from '@effect/sql-pglite'
import * as PostgresPglite from '@nmtjs/workflows/postgres/pglite'

const database = Layer.orDie(PgliteClient.layer())
const store = Postgres.layer().pipe(
  Layer.provide(PostgresPglite.notifications),
  // `install` is for tests; production migrations are the application's.
  Layer.provide(Layer.effectDiscard(Effect.orDie(Postgres.install))),
  Layer.provideMerge(database),
)
```

## Transactions

A `Client.*` call made inside the caller's `sql.withTransaction` joins that
transaction: the run commits or rolls back with the application's writes,
its hints are sent at commit, and its guards are held until then. A fiber
forked inside the transaction is part of it too.

```ts
const placeOrder = (order: typeof Order.Type) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO orders (id) VALUES (${order.id})`
        return yield* Client.start(Charge, order)
      }),
    )
  })
```

A start refused inside the transaction (`IdempotencyConflict`, `RunConflict`,
`DefinitionConflict`) rolls back only itself, to a savepoint: catch it and
the caller's transaction can still commit its other writes. The in-memory and
Redis stores run the same `Client` code without a transaction.

A failed statement, a lost connection or contention that did not clear is a
`StorageError` carrying the `SqlError`. Workers log it and try again; clients
return it. Nothing of the operation applies unless it failed while
committing. Deadlocks against locks the adapter does not order are retried a
bounded number of times. Run ids are the exact text the store returned; another
spelling of the same UUID names no run.

## Schema and migrations

The schema is generation **7**. The application owns production migrations.

- `createSchema({ searchIndexes? })` from `@nmtjs/workflows/postgres/drizzle`
  returns the tables and enums as Drizzle objects; object names are fixed.
  `searchIndexes: true` adds GIN indexes for the `tags` / `input` list
  filters, at a cost on every run write. The optional `drizzle-orm` peer is
  `>=1.0.0-rc.4 <2.0.0`.
- `Postgres.verify` dies unless the schema on `search_path` is generation 7
  with the columns and indexes the adapter needs. Run it at startup;
  building the layer verifies nothing.
- `Postgres.install` creates generation 7 on an empty database; it is for
  tests and local development, not production migrations.
- Tables: `workflow_runs`, `workflow_nodes`, `workflow_node_children`,
  `workflow_attempts`, `workflow_keys`, `workflow_definitions`,
  `workflow_commands` (dead commands have `dead_at`), `workflow_schedules`,
  `workflow_schema_version`. Unqualified: set `search_path` to place them in
  a schema.

Generation 7 adds what durable workflows store: the node kinds `sleep`,
`now` and `input`, and `workflow_nodes.operation`. It only adds, so it takes
no time that grows with history. Stop the older workers, then run
`Postgres.migrateFrom6` (in process) or `MIGRATION_FROM_6_SQL` in one
transaction.

Generations 1 to 4 belong to the Promise engine; its last release,
`@nmtjs/workflows@0.18.0-alpha.4`, installs generation 4. No release
installed a generation 5. To upgrade:

1. Bring the database to generation 4 with that release's upgrades.
2. Stop starting runs on the old engine and let it finish or cancel them.
3. Stop every process of the old engine.
4. Run `Postgres.migrateFrom4` (in process) or `MIGRATION_FROM_4_SQL` (a
   script) in one transaction, then start the new engine. It ends at
   generation 7, the steps from 6 included.

The migration refuses unless the generation is 4, every run has ended and
no command is queued; dead commands are deleted. It keeps history, identity
keys and schedules, all unversioned (a failed old run is retried by a
worker serving its name without a revision), rebuilds the command queue,
and locks
`workflow_runs` / `workflow_commands` for its whole length. The package's
`src/postgres/README.md` lists every column it changes.

## Retention

History stays until removed: give a coordinator `retention: { olderThan,
statuses? }` or call `Client.pruneRuns`. Only fully ended root families are
removed, whole. Saved definitions are never deleted.
