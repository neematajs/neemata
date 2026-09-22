# PostgreSQL workflows

Use `@nmtjs/workflows/postgres` for `createPostgresWorkflowConnection`,
`createPostgresWorkflowRuntime`, `verifyPostgresWorkflowSchema`,
`createPostgresWorkflowWakeEvents` and connection/listener types.

## Clients and transaction scopes

`createPostgresWorkflowConnection(client)` accepts these structural surfaces:

- A `pg.Pool`: `query`, `connect()`, and a borrowed client with
  `query` / `release()`. Pool detection also checks for `totalCount`,
  `idleCount` or `waitingCount`; `connect` alone is not sufficient.
- A connected `pg.Client` / query-only client: transactions use
  `BEGIN` / `COMMIT` / `ROLLBACK` on that session.
- A transaction-capable client such as PGlite: `query` plus
  `transaction(handler)`, where the handler receives a query client.
  Its transaction API takes precedence over pool detection.

Other drivers can implement `WorkflowPostgresConnection` directly.
The application opens and closes the client/pool. The wrapper releases borrowed
pool clients; it does not connect a plain client or close application
resources.

The runtime connection API is:

- `query<T extends Record<string, unknown>>(sql: string,
params?: readonly unknown[]): Promise<{ readonly rows: readonly T[] }>`.
- `transaction<T>((connection: WorkflowPostgresConnection) => Promise<T>)
: Promise<T>`.

Inside a transaction, use only the connection passed to its callback. Nested
`transaction` calls make savepoints; failure rolls back that nested scope,
leaving the enclosing transaction usable. Queries and sibling nested scopes
on one transaction connection are serialized because savepoints form a stack.
A plain single-session wrapper also serializes top-level queries with whole
transactions. A pool can run independent transactions on separate sessions.

Awaiting the parent connection from inside a nested scope can deadlock on that
serialization; with a pool it can instead run outside the intended transaction.
Do not reuse a scoped connection after its handler settles. It rejects new work
then, and commit/rollback waits for already queued work to finish. Await all
transaction work inside the callback.

```ts
import { Pool } from 'pg'
import { defineTask } from '@nmtjs/workflows'
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'
import * as z from 'zod'

const persistTask = defineTask({
  name: 'documents.process',
  input: z.object({ id: z.string() }),
  output: z.object({ processed: z.boolean() }),
})
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const connection = createPostgresWorkflowConnection(pool)
await verifyPostgresWorkflowSchema(connection)
const runtime = createPostgresWorkflowRuntime({ connection })
const client = createWorkflowRuntimeClient(runtime)

await connection.transaction(async (tx) => {
  // App writes and workflow dispatch must commit or roll back together.
  await tx.query('SELECT pg_advisory_xact_lock($1)', [42])
  await client.start(
    persistTask,
    { id: 'd1' },
    {
      connection: tx,
      idempotencyKey: ['documents.process', 'd1'],
    },
  )
})

// At application shutdown, after its workers and watchers have stopped:
await runtime.dispose?.()
await pool.end()
```

`start(..., { connection: tx })` returns a provisional run until the outer
transaction commits. Pass the callback's connection or a nesting-aware external
transaction wrapper. Never wrap a bare query client already inside an external
transaction: a new `BEGIN` / `COMMIT` would not preserve the caller's boundary.
The in-memory adapter ignores a passed connection so PostgreSQL-facing code
runs unchanged in tests.

## Timestamps and runtime options

Runtime timestamps are Unix milliseconds, including options and returned records.
PostgreSQL columns remain `timestamptz`; writes use Date parameters internally.
The caller owns timestamp parsers. Supported results are a `Date` (the pg and
PGlite defaults), column text, or Unix milliseconds. An unreadable timestamp
throws `TypeError` rather than allowing `NaN` into a record; do not configure
a parser to return an unsupported representation such as a Temporal object.

`createPostgresWorkflowRuntime({ connection, maxDeliveries?, wakeEvents? })`
returns store, executors, scheduler, retention pruner, atomic hooks and
`connection`. `maxDeliveries` defaults to 20. Run start/dispatch, continuation
and completion use transactions. This does not make handler side effects
transactional. Runtime disposal only disposes supplied wake events; the caller
still closes its command connection/pool.

## Schema and migrations

The schema version is **4**, exported as
`WORKFLOW_POSTGRES_SCHEMA_VERSION` alongside
`WORKFLOW_POSTGRES_SCHEMA_MANIFEST`.

- `createSchema({ searchIndexes?: boolean })` from
  `@nmtjs/workflows/postgres/drizzle` returns `tables` and `enums`.
  Canonical physical names are required. Search GIN indexes on input/tags are
  opt-in (default false) because they add write cost.
- The optional Drizzle peer range is `>=1.0.0-rc.4 <2.0.0`.
  Applications own production migrations and seed/update
  `workflow_schema_version` with `id = 1, version = 4` after applying them.
- Follow the package README's migration sections in order, with workers stopped.
  Version 2 adds/backfills `active_since`; version 3 adds/backfills
  `retry_attempt_number`; version 4 adds
  `workflow_node_children.cancellation` and
  `workflow_commands_attempt_idx` on non-null `attempt_id`.
  Existing child edges with null cancellation propagate.
- `verifyPostgresWorkflowSchema(connection)` verifies version and required
  database objects at startup. Creating the runtime does not run migrations.
- `installPostgresWorkflowSchemaForTesting(connection)` from
  `@nmtjs/workflows/postgres/testing` bootstraps tests/local development;
  it is not production migration tooling.

Retention requires terminal families and preserves unreaped dead commands.
`batchSize` bounds root deletion per batch.

## LISTEN ownership

`createPostgresWorkflowWakeEvents({ connect, reconnectDelayMs?, onError? })`
opens a dedicated LISTEN connection; `connect` must return a connected client
and may be called again after connection loss. A connected `pg.Client`
satisfies `WorkflowPostgresListenerClient` with `query(sql)`,
`on('notification' | 'error' | 'end', listener)`, and `end()`.

Pass the result as `wakeEvents` when constructing the runtime. It listens for
command, cancellation and family-change notifications, reconnects with a default
1,000 ms delay, and closes its listener through `dispose()` (also called by
runtime disposal). The command pool remains application-owned.

Notifications reduce latency; polling/heartbeats remain the execution fallback.
Coarse watcher changes are best-effort, without event replay. Delayed command
enqueue skips the immediate wake.
