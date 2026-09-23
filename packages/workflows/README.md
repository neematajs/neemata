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

Postgres runtime code lives behind explicit subpaths:

```ts
import { createWorkflowRuntimeClient } from '@nmtjs/workflows/runtime'
import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  verifyPostgresWorkflowSchema,
} from '@nmtjs/workflows/postgres'
import { createSchema } from '@nmtjs/workflows/postgres/drizzle'
```

## Schema codecs

Workflow contracts use `effect/Schema`, pinned to `4.0.0-rc.116`. Applications and
`@nmtjs/workflows` must use this exact version during the release-candidate period.
The package imports only stable Effect modules. Async handler execution and the
existing dependency container remain in place until the next migration slice.

```ts
import * as Schema from 'effect/Schema'

const normalizeDate = defineTask({
  name: 'normalize-date',
  input: Schema.DateFromString,
  output: Schema.DateFromString,
})

const implementation = implementTask(normalizeDate, {
  handler: async (_ctx, date) => date.toISOString(),
})
```

Submissions, input-mapping callbacks, map `items` callbacks, handler returns, and
`finish` returns use the schema's **Encoded** type. Handlers and workflow callbacks
receive its decoded **Type**, including prior node outputs and individual map
items. An omitted input mapper forwards the decoded workflow input. `client.start`
returns decoded input (and output when joining a completed run).

For the upcoming Effect handler migration, task/activity handlers and `finish`
will return decoded Type, and the boundary will encode once. The Encoded return
convention above describes the current async implementation during slice 4.

Durable payloads use `Schema.toCodecJson`: inputs, outputs, map items, schedules,
and attempt commands are encoded before storage and decoded before execution or
resumption. History APIs expose that stored representation; they do not require
registered definitions. Restart reconstructs the submission value with the current
definition's codec and returns a decoded `RunnableRun`, like `start`. Retry and
restart eligibility are unchanged.

| Schema                    | Authored Encoded | Decoded Type | Stored JSON |
| ------------------------- | ---------------- | ------------ | ----------- |
| `Schema.DateFromString`   | string           | `Date`       | ISO string  |
| `Schema.Date`             | `Date`           | `Date`       | ISO string  |
| `Schema.NumberFromString` | string           | number       | string      |
| `Schema.Undefined`        | undefined        | undefined    | null        |

The undefined-to-null encoding also applies inside structs. For example,
`Schema.optional(Schema.String)` stores an explicitly supplied `a: undefined` as
`"a": null`; an absent `a` key remains absent. Decoding restores the supplied
undefined value, while SQL/history readers see null.

Codecs must be synchronous, require no Effect services, and support JSON encoding.
Custom types need a JSON codec supported by Effect's `toCodecJson` derivation.
JSON derivation support is checked when actual values are encoded, not at definition
or worker registration. For example, `Schema.instanceOf(URL)` alone accepts a URL
at the authored boundary but cannot persist it. Test custom codecs with representative
values before deployment; node-level encoding failures can otherwise occur mid-run.
`Schema.Unknown` accepts only JSON-compatible values at persistence boundaries;
use `Schema.Undefined` for an explicit void value. A workflow without an output
schema may return JSON or finish without a value; rich outputs require a schema.
Encoding and decoding failures use the existing workflow failure/retry paths.

Plain JSON contracts retain their payload representation. Transformed contracts
can differ from the old decoded-value-then-`JSON.stringify` representation: for
example, `NumberFromString` persists a string rather than a number. Stored-data
compatibility must therefore be assessed before deployment. At cutover, pause new
starts and schedule firing, drain old runs and their children, and stop old workers
before enabling new writers. Re-entry decode failures are terminal. Retained history
needs a separate compatibility check before resubmission; draining does not convert
it. This slice adds no format marker, history restriction, or retry/restart ban.

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
