# @nmtjs/workflows

Typed workflow and task primitives for Neemata.

## Imports

Declaration and implementation APIs stay dependency-light:

```ts
import {
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '@nmtjs/workflows'
```

Runtime adapters live behind explicit subpaths:

```ts
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'
import { createSchema } from '@nmtjs/workflows/postgres/drizzle'
import { createRedisWorkflowRuntime } from '@nmtjs/workflows/redis'
```

## Redis / Valkey Runtime

Use the Redis runtime as a separate hot-path runtime when dispatch latency and
queue throughput matter more than long-term retention or SQL inspection. It
implements the same workflow client and worker APIs as the Postgres and
in-memory runtimes:

```ts
import { Redis } from 'ioredis'
import { createRedisWorkflowRuntime } from '@nmtjs/workflows/redis'
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  commandTimeout: 2_000,
})
const runtime = createRedisWorkflowRuntime({
  client: redis,
  keyPrefix: 'chat-workflows:',
  terminalRetentionMs: 15 * 60 * 1000,
})
const workflows = createWorkflowRuntimeClient(runtime)
```

The runtime also accepts an `iovalkey` client. Queue transitions use SHA-loaded
Lua scripts for atomic deduplication, claiming, lease fencing, acknowledgement,
retry/dead-letter movement, and stalled-claim recovery. Pub/Sub is only a wake
hint; sorted sets and hashes remain the durable execution state, so a missed
notification falls back to polling.

Workflow families are partitioned into small per-family hashes for runs, nodes,
children, attempts, leases, and indexes. Each state transition validates and
updates only the affected hash fields in one atomic Lua operation; the runtime
does not hold distributed locks or perform client-side compare-and-swap retry
loops.

Redis stores runtime timestamps as Unix milliseconds; the shared client and
worker APIs still return `Date` objects. Application payloads are stored as
opaque JSON so Lua transitions preserve empty arrays, numeric precision, and
payload fields that happen to have timestamp names. Lease deadlines and
retention use Redis server time to avoid disagreement between worker clocks.
The timestamp format and queue indexes are incompatible with earlier experimental
adapter data, including versions without route/run indexes. Finish existing work
with that version before switching to a fresh `keyPrefix`; do not mix adapter
versions in one namespace.

Active run families never receive a TTL. Retention starts only when every run
in the root family is terminal, then the complete family and its lookup keys
expire together. This prevents a live child from losing its parent state while
keeping historical runs from filling Redis memory.
Lookup keys reused by a newer run retain that run's ownership. Routed polling
removes expired-family commands when they become due on a worker's routes.
Retention maintenance also sweeps abandoned routes and commands with future
schedules or leases; run `store.pruneTerminalRuns()` periodically, or configure
worker retention, to reclaim those commands and their indexes. The terminal-run
index expires after its latest retained entry.

Delayed starts and retry backoff are supported. Recurring/cron schedules are
intentionally not part of the Redis runtime; use a Postgres runtime for durable
scheduled and background work. A single application can register separate
named Redis and Postgres runtimes and choose between them per workload.

Ready and claimed commands have route indexes, so polling and lease recovery
inspect only the worker's workflows, activities, and tasks. Claims compare the
oldest due command across the selected routes. Per-run indexes scope manual
retry, cancellation, and family deletion to the affected runs. Lua maintains
these indexes atomically with queue transitions. Manual retry still performs
work proportional to the affected family and its own retained commands;
retention maintenance scans shared queues in bounded batches.

The caller owns the command client and must close it. `runtime.dispose()` closes
only the duplicated Pub/Sub connection. Redis Cluster is not supported in this
version because atomic operations span the runtime namespace; use a standalone
or Sentinel-managed Redis/Valkey deployment with an isolated `keyPrefix`.
Keep command retries and timeouts finite. Reconnecting and completing one
command are separate concerns: the client may continue reconnecting for future
work, while `maxRetriesPerRequest` and `commandTimeout` bound the promise for an
individual workflow operation. Never use `maxRetriesPerRequest: null` here; it
allows a command to remain queued across an unlimited reconnect cycle. A
timeout is ambiguous because Redis may have committed before its response was
lost, so retry the same high-level workflow operation with the same idempotency
identity. Transitions are idempotent or fenced; do not retry raw Redis commands
outside the runtime. The values above are starting points and may be increased
to cover normal deployment latency and failover, but they must remain finite.

Queue durability survives worker and client failures, but recovery after a
Redis/Valkey service restart depends on the deployment's own persistence and
replication configuration. Enable an appropriate AOF or RDB policy for the
workload; the runtime cannot reconstruct data that the service did not persist.
Use a `noeviction` max-memory policy so memory exhaustion fails an operation
explicitly instead of silently evicting one part of a workflow family. Terminal
retention bounds historical state, but capacity must still cover the maximum
concurrent active state and ready/claimed queue backlog.

## Runtime Connection

Runtime code consumes a small `WorkflowPostgresConnection` interface. For
`pg`-style clients and pools, wrap the app-owned client:

```ts
import { Pool } from 'pg'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'

const connection = createPostgresWorkflowConnection(
  new Pool({ connectionString }),
)

await verifyPostgresWorkflowSchema(connection)

const runtime = createPostgresWorkflowRuntime({ connection })
```

Other clients can pass a custom object that satisfies `WorkflowPostgresConnection`.

## Wake Events (LISTEN/NOTIFY)

Command dispatch and cancellation are poll-based by default: dispatch latency
is bounded by the worker poll interval, cancellation latency by the attempt
heartbeat cadence (`leaseMs / 3`). The Postgres runtime can layer
`LISTEN/NOTIFY` wake-up hints on top so idle workers wake immediately when a
command is enqueued and running attempts observe cancellation right away:

```ts
import { Client, Pool } from 'pg'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  createPostgresWorkflowWakeEvents,
} from '@nmtjs/workflows/postgres'

const wakeEvents = createPostgresWorkflowWakeEvents({
  // dedicated LISTEN connection, one per worker process
  connect: async () => {
    const client = new Client({ connectionString })
    await client.connect()
    return client
  },
})

const runtime = createPostgresWorkflowRuntime({ connection, wakeEvents })
```

Notifications are fire-and-forget hints: a missed one (disconnect, restart)
degrades to the existing polling behavior, never to lost work. With wake
events enabled, generous poll intervals and lease durations keep idle database
traffic low without sacrificing dispatch or stop latency. The tradeoff: every
immediate command enqueue and cancellation adds a `NOTIFY` to its transaction,
and Postgres serializes commits of notifying transactions — under very high
dispatch throughput this can reduce commit parallelism. Delayed commands skip
the hint entirely. The listener
reconnects automatically after connection loss; `wakeEvents.dispose()` runs as
part of `runtime.dispose()`.

## Postgres Schema

Applications own production migrations. The package exports Drizzle schema
objects so apps can include them in their own migration flow:

```ts
const workflows = createSchema()

export const WorkflowRunTable = workflows.tables.runs
export const WorkflowNodeTable = workflows.tables.nodes
export const WorkflowRunKind = workflows.enums.runKind
```

`createSchema()` emits the canonical physical table and enum names required by
the runtime. Custom database object names are not supported yet.

Your migration must also seed the schema version row used by startup
verification:

```sql
INSERT INTO workflow_schema_version (id, version)
VALUES (1, 2)
ON CONFLICT (id) DO UPDATE SET version = EXCLUDED.version;
```

Use `verifyPostgresWorkflowSchema(connection)` at startup to fail fast when the
installed schema does not match the runtime. The helper
`installPostgresWorkflowSchemaForTesting(connection)` is available from
`@nmtjs/workflows/postgres/testing` for tests and local development only, not
production migrations.

## Retrying failed work

`client.retry(runId, { expectedVersion })` reopens a failed root run in place.
The ID, input, tags, idempotency key, successful nodes and child runs are retained.
Only failed work executes again, using the previous attempt's stored input and
idempotency key. Attempt history and absolute attempt numbers are preserved;
manual retry replenishes the automatic retry budget and resets exponential
backoff for each reopened child. `expectedVersion` is optional, but management
UIs should supply the version they displayed to reject stale retry requests.

`client.restart(runId, options)` creates a new root run from the stored input.
It accepts failed, completed and cancelled roots, plus the same start options
as `start()`. This is the old `retry()` behavior. Definitions are required by
`restart()` for name resolution; in-place `retry()` is registry-free. Existing
uniqueness and idempotency rules still apply to a restart. In-place retry always
rejects an occupied uniqueness key, even when the constraint normally joins.

All `parallel`, `mapTask` and `mapWorkflow` nodes wait for every child to settle.
Failures do not cancel siblings or stop admission of pending map items. A node
succeeds only when every child succeeds; otherwise it fails after settling.
Explicit cancellation still cancels unfinished work. The map `mode` option and
mode-specific output types were removed. Successful map output is always
`{ items: { item, index, runId, output }[] }`, in original item order. Expected
business rejections belong in typed task outputs; thrown errors remain runtime
failures. Consumers of `start-only` now wait for child completion, and consumers
of `wait-settled` must stop reading per-item runtime status from successful output.

After retry, refresh the same run and open a new `watch()` iterator: the previous
iterator ended when the run failed. A retry is rejected while a coordinator or
attempt still holds a live lease; allow it to settle before retrying. This avoids
restarting work while its previous handler is still completing. Handlers must
still make external side effects idempotent, as with ordinary crash recovery.

## Schema version 2 migration

Apply this application-owned PostgreSQL migration before deploying this version,
with workflow workers stopped. It preserves the timeout age of existing runs.
New retries reset `active_since`; ordinary progress does not extend the timeout.

```sql
BEGIN;
ALTER TABLE workflow_runs ADD COLUMN active_since timestamptz;
UPDATE workflow_runs SET active_since = created_at;
ALTER TABLE workflow_runs
  ALTER COLUMN active_since SET NOT NULL,
  ALTER COLUMN active_since SET DEFAULT now();
UPDATE workflow_schema_version SET version = 2 WHERE id = 1;
COMMIT;
```

Attempt errors remain in immutable attempt history. Run/node callback errors are
current-state fields and are cleared by retry; durable callback-error history and
workflow-definition version pinning are outside this change.

## Schema version 3 migration

Apply after the version 2 migration, with workflow workers stopped. Existing
attempts retain their prior retry accounting; the next manual retry starts a
fresh budget while absolute attempt numbers and history remain unchanged.

```sql
BEGIN;
ALTER TABLE workflow_attempts ADD COLUMN retry_attempt_number integer;
UPDATE workflow_attempts SET retry_attempt_number = attempt_number;
ALTER TABLE workflow_attempts ALTER COLUMN retry_attempt_number SET NOT NULL;
UPDATE workflow_schema_version SET version = 3 WHERE id = 1;
COMMIT;
```
