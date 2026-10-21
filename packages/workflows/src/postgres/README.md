# PostgreSQL adapter

`Store` on Effect SQL. It depends on `SqlClient` and nothing else, so one code
path serves `@effect/sql-pg` and `@effect/sql-pglite`.

```ts
import { PgClient } from '@effect/sql-pg'
import * as Postgres from '@nmtjs/workflows/postgres'
import * as PostgresPg from '@nmtjs/workflows/postgres/pg'

const store = Postgres.layer({ maxDeliveries: 20 }).pipe(
  // Optional: without it workers find their work by polling alone.
  Layer.provide(PostgresPg.notifications),
  Layer.provide(PgClient.layer({ url })),
)
```

Build the client without name transforms. The adapter is written for
`READ COMMITTED`, the default.

An engine call made inside the caller's `sql.withTransaction` is part of that
transaction: it commits or rolls back with it, its hints are sent when it
commits, and the guards it took are held until then. A fiber forked inside a
transaction is part of it too. A call that is refused there, as a start is by
`IdempotencyConflict`, `RunConflict` or `DefinitionConflict`, undoes only
itself, to a savepoint: the caller's transaction stays usable and commits its
other writes.

A statement the database fails, a lost connection and a contention that did
not clear are a `StorageError` carrying the `SqlError`: workers log it and try
again, the client gives it to its caller. Nothing of the operation is applied
then, unless the failure came while its transaction was committing.

## Options

| Option            | Default          | Means                                                           |
| ----------------- | ---------------- | --------------------------------------------------------------- |
| `maxDeliveries`   | `20`             | a command claimed more often than this is set aside as dead     |
| `channel`         | `workflow_hints` | where hints are notified: 1 to 63 bytes                         |
| `answerTimeoutMs` | none             | how long the database has to answer each statement of the store |

An option that makes no sense is refused when the layer is built, which then
dies: a count that is no positive integer, a channel `LISTEN` would cut short.

With `answerTimeoutMs`, a statement the database has not answered in that
time is cancelled, and its operation fails with a `StorageError` whose cause is
an `SqlError` of reason `StatementTimeoutError`. It is the time for an answer,
whatever the statement waits for: one that waits for a guard which another
transaction holds for longer fails too. For `claim`, `release` and `renew`,
which are one statement each, the outcome is then unknown, as the contract says
of a failure while committing.

The statements that begin and end a transaction are the client's own, and
`answerTimeoutMs` does not reach them; nor does it bound the wait for the
statement it cancels, which `@effect/sql-pg` gives 5 seconds before it drops
the connection. A database that has stopped answering, stalled or cut off,
answers neither `COMMIT` nor a cancel, and the server's own settings
(`statement_timeout`, `lock_timeout`) only help one that still answers. Such a
transaction waits without end, and so does the client's close, which waits for
every connection out: a worker on that store cannot stop. On `@effect/sql-pg`,
`PostgresPg.stream` gives the client sockets with a deadline of their own:

```ts
const client = PgClient.layer({
  url,
  // The address again: the client hands the stream no part of `url`.
  stream: PostgresPg.stream({ host, port, answerTimeoutMs: 10_000 }),
})
```

A connection that has sent something and heard nothing for that long is
destroyed, which fails what waits on it with a `ConnectionError`, its
transaction included. It bounds the time to the first byte of an answer, for
every statement of the client, the application's too: one that runs or waits
for a lock for longer is cut as well. So its deadline is above the longest
statement of the client, and above the store's `answerTimeoutMs`, which
cancels a statement and keeps its connection. A connection that owes nothing,
idle or listening, is never cut. Of statements pipelined on one connection,
as a `multiplex` client sends them, only the first answer is waited for. TLS,
when the client asks for it, runs over these sockets as over its own.

Closing a store does not wait for `UNLISTEN` on the connection it listened
on: the connection goes back to the pool when the database confirms it or the
connection is lost, and the client's close waits for that, which the
deadline bounds.

Hints travel on one `LISTEN` channel, `workflow_hints` unless `channel` says
otherwise. A channel belongs to the database, so stores of two schemas in one
database hear each other's hints unless they are given different channels;
that costs needless claims and nothing else.

## How a commit is guarded

Everything a scope names is guarded by an advisory transaction lock on its
name: `run:<id>` for runs, heads, units, runs opened, results and the roots
of families,
`key:<key>`, `definition:<key>`, `schedule:<name>`, and `schedules` for which
schedules exist. A name guards absence as well as presence, which a row lock
cannot.

A unit is read by its keys alone, in the statement that loads the rest: its
node by `(run_id, name)`, its child by `(run_id, node_name, child_key)` and
its attempt by id, each a primary key, with the attempt found only when its
run, node and child are the unit's. Its run is loaded and held as a head is.
Nothing else the run owns is read, and the run's guard is taken alone as for
a run loaded whole: a unit shuts out every other writer of its run.

A run opened is read in the same statement, by indexes and keys alone: the
run, its nodes with their columns named one by one, a map's without `input`,
and of each node that has not ended its children by an index of their own.
Those of a map under way come from `workflow_children_active_ordinal_idx`;
of those waiting, `workflow_children_pending_ordinal_idx` gives the first by
ordinal, one more than the window asked, which tells whether more wait and
is read no further: neither its attempt nor its run. A window is counted in
`bigint`, so no limit a plan names, nor the one past it, overflows. The
children of any other node are read all, and a map the scope does not name
has none read. Then the current attempt of each child read, by id. A node's
results are the node whole and all its children by ordinal, which
`workflow_children_ordinal_idx` holds in order. Both are guarded and held as
a run loaded
whole is: the run's guard is taken alone, and its row and its parent's are
key-shared.

A run opened is shown, too, the run of each child read that has not ended,
which a pass observes, guarded and held as a head is. Their guards are taken
with the rest: the statement that takes them first selects those children,
as the read will, and guards their runs in the same order. That statement
sees the children as they were when it began, and a pass it waited for may
have started more since: the load guards their runs with
`pg_try_advisory_xact_lock`, which never waits, and so never breaks the
order. A run whose guard another holds is not shown, and the plan asks for
it, in a transaction of its own.

A node written but for its input is an `UPDATE` of the columns but `input`,
over a row that exists: it adds none, and the commit is refused as a defect
when one is not there.

A definition is saved once and never changed, so its guard is taken shared
by the commits that only read it, as every start and pass of it does, and
alone only by one that saves it. Commits that read a saved definition never
wait for one another, however long a caller's transaction that started a run
of it stays open; one that saves it waits for those that read it absent, and
they for it. A plan that turns out to save what it read under a shared guard
is run again with that guard taken alone.

The locks of a scope are taken in one statement, in the order of their lock
ids, by a transaction that holds none, with those of the runs of the children
a run opened will be read with, when its read asks for them. When a plan needs more, the transaction
is rolled back and started again with the wider scope, so locks are never
added to locks already held. Two commits therefore never wait on each other,
whatever order their plans ask in.

The plan then runs on what was read under the locks, and its mutation is one
statement: records, keys, definitions, acknowledged claims, new commands and
their hints are applied together or not at all. The load and the commit are
each made of the parts the scope and the mutation have, and nothing of the
others: the database plans and runs every part of a statement, empty or not,
and a prepared statement's plan takes each list it is given for a hundred
rows, so each list is read by the keys of its table. Before it is sent, what the
mutation writes of what runs own is checked against what was read: a run
loaded whole or created, or else what a unit, an open read or a results
read found, what an open read found absent, and attempts with an id of this
transaction under a child it may write. A guard held is not a record seen,
and a window of a map's children is not all of them. A run is written over
only where its record was read: any other is created, and refused when it
exists, as a family's root is, which a family read guards and does not read.

A commit hints every command it wants due, and every one it does not add,
whenever wanted. One not added for a command of its key that waits due
may have met that command at the unique index, which then stays locked to
this commit, and a claimer woken by the commit that queued it passes over it
as locked: the commits of two children that end at once each wake their
parent so. What waits may be due when the one queued is not, and only this
commit can then say so; a hint for nothing due costs a claim that finds
nothing.

What a name does not reach is held as rows:

- **What a transaction loads.** The removal of a family names only its root,
  and the runs under it, what they own and the keys they hold go by the
  foreign keys, past their guards. So the statement that loads runs and keys
  takes a key share of their rows, which a deletion waits for: a family is
  not removed under a plan that loaded a run or a key of it, and a plan that
  comes after the removal is shown them gone. It costs one row lock for each
  run and key loaded, and no round trip.
- **The parents of what a transaction loads.** A run that ends wakes its
  parent without loading it, from the parent's route it keeps, and the
  foreign key of that command takes a key share of the parent's row. Taken at
  the commit, it would wait for a removal that has locked the parent and
  waits for the run. So the parents are key-shared by the same statement, in
  the same order as the runs, and are not shown to the plan.
- **Dead commands.** A command's id is the database's, so one that is absent
  never appears; one that is there is locked when loaded, dead or not, and
  nothing sets it aside, takes it away or claims it before the commit.
- **Claims.** A statement that acknowledges, holds, renews or releases a claim
  locks the command's row first and judges the claim after, by the token and
  the expiry the lock found and the clock as it is then. A statement that
  judged first would not judge again when a row it waited for came back
  unchanged, and would act on a lease that ended during the wait. A renewed
  lease counts from when the row was had.
- **Families.** Only the root of a family is guarded, and the runs under it
  are counted in the database, never loaded. A commit that was planned on a
  family and writes anything locks the root's row, then the row of every run
  under it, then counts them, in three statements. A run enters a family
  holding a key share of its root, so the first waits for every run on its
  way in and none enters after; the second waits for whoever writes a run of
  it or has one loaded; the third counts what now stays. When the counts are
  not what the plan was shown, it is planned again. Removing a family is then
  one `DELETE` of its runs.

A run a plan writes without having loaded it is one it creates. An id the
transaction made itself is known to nobody else. For any other, the commit
first takes the run's guard, so the insert waits for whoever loaded that id as
absent, and is refused as an unguarded write when they created the run.

A deadlock remains possible against locks the adapter does not order: the row
locks of a family that is being removed while a run of it is written, the
guard of a run created under an id another transaction loaded, two plans that
load dead commands the other takes away, a caller's transaction that makes
several engine calls, or other users of the tables. Its victim is run again, a
bounded number of times.

An id is the text the store gave, as the contract says: a uuid as the database
writes one. The database would read the same uuid in capitals or without its
hyphens, so an id in any other spelling is never sent to it: it names no run,
no guard and no claim, and a write under it is refused as a defect.

## Schema

`install` creates generation 7 on a database without workflow tables; it is
for tests and local development. `verify` dies unless the schema on
`search_path` is generation 7 with the columns and indexes the adapter's
statements need. `@nmtjs/workflows/postgres/drizzle` has the same schema
as Drizzle objects, for applications that keep their migrations with Drizzle.

A node's children are indexed by `(run_id, node_name, ordinal, child_key)`
three times over: all of them (`workflow_children_ordinal_idx`), those
waiting (`workflow_children_pending_ordinal_idx`, `WHERE status = 'pending'`)
and those under way (`workflow_children_active_ordinal_idx`, `WHERE status
IN ('running', 'waiting', 'cancelling')`). A pass of a map reads a window of
the second and all of the third, so what it reads is near what may run at
once however many items the map has; a map that is done reads all its
children once.

`createSchema({ searchIndexes: true })` adds two GIN indexes the adapter does
not need, for lists of runs (`runs`) that filter by what they index:
`workflow_runs_tags_gin_idx` serves the `tags` filter and
`workflow_runs_input_gin_idx` the `input` filter, which are both containment
(`@>`). No other filter uses them. They cost every write of a run, so they
are off unless asked for, and `verify` asks for neither.

| Table                     | Holds                                         |
| ------------------------- | --------------------------------------------- |
| `workflow_runs`           | run records                                   |
| `workflow_nodes`          | node records                                  |
| `workflow_node_children`  | child records                                 |
| `workflow_attempts`       | attempt records                               |
| `workflow_keys`           | identity keys: the run holding each           |
| `workflow_definitions`    | saved definition records, by key              |
| `workflow_commands`       | the queue, dead commands included (`dead_at`) |
| `workflow_schedules`      | schedule records, by name                     |
| `workflow_schema_version` | the generation                                |

Ids are UUIDv7, so runs made at one instant are listed in the order they were
made in, exactly so when one process made them.

Times are stored as `timestamptz` and read back as whole Unix milliseconds,
rounded down. The engine writes whole milliseconds; a column can hold
microseconds all the same, set by `now()` (as generation 4 set several, and
column defaults do) or by hand, and reads as the millisecond it falls in. A
filter by time compares what the column holds, so a schedule whose
`next_run_at` is past a whole millisecond is due a millisecond after the one
it reads as. Cursors keep the microseconds.

A command's row says where it is: `lease_token` is set by its first claim and
kept, `lease_expires_at` is set while a claim is out. A command with no token
was never claimed, one with a token and no expiry was given back, and a claim
holds while the token is its own and the expiry is ahead. `seq` is the order
commands were queued in, which is the order of delivery.

One command never claimed may wait for a key, which
`workflow_commands_fresh_idx` enforces. Two commits that queue one key at once
see neither's command: the second meets the first's at that index and, in the
same statement, makes it due no later than its own would have been
(`ON CONFLICT … DO UPDATE`).

A claim reads the head of each lane it serves, a lane being a kind, a name
and a revision or none, from `workflow_commands_lane_idx`, which holds every
lane in the order of `seq`. Commands of other lanes are not read, and those
of its own that are not due yet are passed over in the index. It reads twice
its limit of a lane at most, and sets aside no more than that of commands
delivered too often: when more of them than that stand first in a lane, the
claim takes fewer than its limit and the next one goes on. Commands held by
another claim (a lease that has not ended) are read and passed over one by
one, so a lane costs a claim what it has in flight.

## Migrating from generation 6

Generation 7 adds what durable workflows store: the node kinds `sleep`, `now`
and `input`, the `operation` column of `workflow_nodes`, and the run status
`blocked`. It only adds, so
it takes no time that grows with the history, and what generation 6 stored
reads as it did. `MIGRATION_FROM_6` is the migration, one statement per entry,
to run in one transaction; `MIGRATION_FROM_6_SQL` is the same as a script, and
`migrateFrom6` runs it. Stop the workers of the older release first: their
code knows no generation 7.

## Migrating from generation 4

Generations 1 to 4 are the schemas of the Promise engine, called the old
engine here; `@nmtjs/workflows@0.18.0-alpha.4`, its last release, installs
generation 4. A database at an earlier generation applies that release's
upgrades to 4 first. No release installed a generation 5, and the migration
refuses every generation but 4.

It ends at generation 7, the steps from 6 included.
`MIGRATION_FROM_4` is the migration, one statement per entry, to run in one
transaction; `MIGRATION_FROM_4_SQL` is the same as a script. Tables are named
unqualified: set `search_path` first when they live in another schema.

**It requires the old engine to be drained and stopped.** The migration checks
and refuses otherwise:

- every run is `completed`, `failed` or `cancelled`;
- no command is queued. Dead commands may remain, and are deleted: their
  payloads are not commands of the new engine, and their runs have ended.

Runs in flight are not converted: their records and commands are the old
engine's, which the new one cannot continue. Let the old engine finish them,
or cancel them, then stop every process of it before migrating. The migration
locks `workflow_runs` and `workflow_commands` for its whole length, so a
process that was left running waits and then fails on the new schema instead
of writing into it.

What it does:

- **History is kept in place.** Runs, nodes, children and attempts keep their
  tables and rows: columns the new records have no field for are dropped
  (`workflow_runs.workflow_name`, `task_name`; `workflow_attempts.worker_id`,
  `lease_token`, `idempotency_key`, `heartbeat_at`;
  `workflow_node_children.item_key`), and `input` of runs and attempts and
  `ordinal` of children may now be `NULL`.
- **Runs stay unversioned.** Generation 4 pinned no revision: its runs get
  `execution_revision`, `graph_hash` and `graph_presentation`, all `NULL`,
  and the new engine serves them on the unversioned route of their name. A
  failed run is retried by a worker that serves its name without a
  revision.
- **Runs under a parent are given the parent's route.** `parent_route_name`
  and `parent_route_revision` are added to `workflow_runs`, and the name is
  filled from each run's parent; the revision stays `NULL`, the parent
  having none. A run wakes its parent by that route, so a failed family that
  is retried after the migration finishes as one started after it. It is
  the one rewrite of rows, of the runs that have a parent; nodes, children
  and attempts are not rewritten.
- **Identity keys move to `workflow_keys`.** The partial unique indexes on
  `workflow_runs` encoded when a key is held; that rule is now the engine's.
  Idempotency keys and `all`-scoped unique keys of stored runs are carried
  over, so a start that repeats one is still answered with its run.
  `migrateFrom4` writes them in the process, with the functions that name the
  keys of new runs, so every key is carried over as the engine writes it. The
  statements of `MIGRATION_FROM_4` write them in SQL, which differs from
  JavaScript for two kinds of value: a number JavaScript prints with an
  exponent (`1e21`, `1e-7`), and an object with a key beyond the Basic
  Multilingual Plane, whose keys JavaScript orders by UTF-16 unit. The
  script refuses to migrate while a run has such a key, naming the runs, and
  changes nothing: migrate those databases with `migrateFrom4`.
- **`workflow_definitions` is created empty**: generation 4 saved no
  definitions. Runs and schedules of a revision save theirs from then on.
- **`workflow_commands` is emptied and rebuilt** for the new queue: `kind`
  becomes text, `name`, `revision`, `dedupe` and `seq` are added, the old routing and
  priority columns and `workflow_command_kind` are dropped.
- `workflow_runs_created_idx` is built for lists of runs, and the three
  indexes of children by ordinal for passes of maps. With the keys, they are
  what takes time that grows with the history kept. A failed map is read by
  them when it is retried.
- `workflow_run_leases` is dropped: coordination needs no lease.
- **Schedules are kept**, each at the slot it was at and with the slot it
  fired last, so no slot the old engine fired is fired again: the run of a
  slot holds a key that was carried over, and is adopted. `workflow_schedules`
  loses `id` (a schedule is its name) and its constraints (the rules are the
  engine's), and gains `time_zone`, `version` and the three revision columns
  of runs, `NULL`. Until a worker reconciles it with its declaration, a
  schedule of the old engine fires unversioned runs, and a cron schedule has
  no zone, so is read in the zone of the process that fires it, as the old
  engine read it.

The optional search indexes `workflow_runs_input_gin_idx` and
`workflow_runs_tags_gin_idx` are left alone.
