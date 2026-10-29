# Architecture of @nmtjs/workflows

How the engine is built, for those who change it. The guide for those who
use it is [`README.md`](./README.md).

The engine keeps the model of the Promise engine it replaced (`@nmtjs/workflows`
up to `0.18.0-alpha.4`: a static graph declared up front, durable runs,
attempts with retries) and none of its internals. Pinned revisions are new
to it.

## How it is built

Four parts, each knowing nothing of the ones after it.

### 1. A store: guarded commits, a queue and reads (`src/store.ts`)

An adapter provides `Store` and nothing else:

- `transact(scope, plan)` loads what `scope` names, hands it to `plan` as a
  `Snapshot`, and applies the `Mutation` the plan returns, all or nothing.
  Everything loaded is guarded: if any of it changed before the commit, the
  plan is run again on a fresh snapshot. A plan may also answer `Need` to have
  more loaded, or `Fail` to refuse with a typed error.
- `claim` / `renew` / `release` are the command queue. A command is delivered
  at least once; a claim is the right to act on it until its lease ends.
  `renew` extends the lease while a handler runs and answers with the head of
  the command's run, which is how a worker learns that the run no longer wants
  the work. `release` gives a command back: with an error the delivery counts
  against the command, without one it does not. A command delivered more often
  than the store allows is set aside as dead.
- A mutation that acknowledges a claim (`ack`), or only requires one to be
  still held (`hold`), fails with `StaleClaim` when it is not, and applies
  nothing.
- `hints` tells idle workers that a command of a kind may be due, and `listen`
  does the same for a topic a mutation may `notify`. Both are only hints:
  workers also poll, and polling is the guarantee.
- `load`, `runs`, `dead`, `claimed`, `schedules` and `prunable` are reads of
  their own moment, served from indexes and guarded by nothing: they find what
  a plan then decides again.

What a scope may name, and a mutation write, beyond runs with their nodes,
children and attempts:

| Scope                        | Loads                                     | Written by                                |
| ---------------------------- | ----------------------------------------- | ----------------------------------------- |
| `runs`, `heads`              | runs with what they own; run records      | `runs`, `nodes`, `children`, `attempts`   |
| `units`                      | a run record, a node, a child, an attempt | the same, of what was found               |
| `open`                       | a run as a pass reads it (below)          | what it found, a map's node but its input |
| `childResults`               | a node with its input, all its children   | the same                                  |
| `keys`                       | identity keys with the run holding each   | `keys` (`acquire`, `release`)             |
| `definitions`                | saved graphs and revision manifests       | `definitions`: saved once, never replaced |
| `schedules`, `scheduleNames` | schedule records; which schedules exist   | `schedules`, `unschedule`                 |
| `families`                   | a root with the counts of the runs under  | `remove`: the whole family, or nothing    |
| `dead`                       | dead commands, by id                      | `enqueue`, which removes those of its key |

A dead command is guarded like everything loaded: a plan that loaded one runs
again when it was removed or queued again before the commit. A family is
loaded as its root and two counts, never as its runs.

A unit is one attempt's share of a run: its record, one node, one child of it
and one attempt of that child (the named one, or the current one), each found
by its keys. It is guarded as its run is, so it conflicts with any write to
the run. What runs own is written by a plan that loaded the run whole or
creates it; of a unit, a plan writes only what was found, and attempts it
makes under the child found, with ids its snapshot gave, as a retry does.
A guard is not a view: an adapter refuses a write to a record the plan did
not read, even of a run it holds (`unloaded`). A run is written over only
where its record was read; any other is created, and refused when it exists,
as is a family's root, which a family read guards without reading. A child
is written only under a node that is stored or that the same mutation
creates: what a run owns is found by its nodes, its removal included. Nor is
a child's ordinal anything but an integer (`malformed`). Beginning
and settling an attempt load its unit and nothing else of the run, and a
unit's records are known from whatever read or made them: the attempt a plan
made, or the one it moved a child to, which is asked for when not read.

A run opened is a run as a coordination pass reads it: its record, every
node, and of each node that has not ended the children it waits on. A map
may have thousands of items, so of a map's children only those under way
and the first that wait, by ordinal, are read, in a window the plan names
from the map's concurrency; and a map's node is read without its input, the
list of its items, which the children each carry their own of. What ended,
children and attempt history alike, is not read. The runs of the children
read that have not ended are read with them, as heads, guarded as heads are:
a pass observes them, and asks for no more in a steady state. A pass of a
program that starts no runs says so (`linked: false`), and they are not
looked for: a child that stands for one anyway is asked for. The plan names
the maps of its program; an adapter knows a map's node by its kind (`MAPS`
of the model) and reads no children of one the plan did not name. A pass
then writes a map's node but for its input (`nodesPreservingInput`), which
stays as stored, and which such a write never names. A map none of whose
children is left to run reads its
results, the node with its input and all its children, once, and checks that
a child stands for each item before it makes up its output.

Cancelling, timing out, reaping and reopening read the run whole, and a pass
that comes to one of them asks for it. All of a run owns is also guarded by
its one guard, so a write of any of it, a child entering a window included,
voids a plan that read any of it.

An id, of a run or of a command, is the exact text a store gave. In another
spelling it names nothing, in every operation of every adapter.

`StorageError` is how every operation that touches storage says the storage
failed it. Nothing of the operation was applied then, unless it failed while
committing: then all of it was applied or none, and which is not known. An
adapter fails with it instead of dying, and never for a mistake of the
caller's: a write to what a plan did not load, or one no store can keep as
given, is a defect, refused before anything is written.

An adapter never interprets a record, but for `STATUSES` of the model: which
statuses end a run, for its indexes and counts. `src/memory.ts` is the
reference adapter: single-threaded, yet it guards and validates as a
concurrent store must. `src/postgres` and `src/redis` are the durable ones;
their READMEs say how each guards a commit.

### 2. Plans: every rule of the engine, as pure functions (`src/plan/`)

Starting a run, a coordination pass, settling an attempt, cancelling, a manual
retry, firing a schedule, removing a family: each is a function from a
`Snapshot` to a `Mutation`. Plans

- are synchronous and pure, and may run more than once;
- read time only from `snapshot.now` and make ids only with `snapshot.id`;
- work on a `Draft` (`src/plan/draft.ts`), a working copy that sees its own
  writes and yields the mutation. It tells what was not loaded from what is
  absent: a read of a record it was not given asks for its unit, its window
  or its run (`Need`), and a write of one is a defect. A child missing from
  a window is not known to be absent, and a node read without its input is
  not one without;
- put everything that must happen together in one mutation: the records, the
  commands that continue the work, and the acknowledgement of the command
  being handled.

Because all rules live here, they are written once for every adapter and are
tested without one. `src/engine.ts` pairs each plan with the scope it needs.

A coordination pass decides everything that stored state allows in one
commit, so coordination needs no lease: a pass that loses a race is planned
again. Attempts are fenced by their command's claim: only the delivery that
still holds it is told to begin (`hold`), and only it can settle (`ack`).

### 3. Workers: claim, run, renew, settle (`src/worker/`)

Workers are Effect programs that orchestrate and decide nothing: a
coordinator claims passes and runs the maintenance sweeps, an execution
worker claims attempts, runs their handlers as supervised fibers, renews
their claims and settles them through plans. Interrupting a worker stops its
handlers and gives their commands back; a crashed worker's commands come back
when their leases end. A storage failure of one command is that command's:
it is given back and the worker goes on.

The engine observes nothing itself: `Instrumentation`
(`src/instrumentation.ts`) is where an application does. The client calls its
`start` around a start, and an execution worker its `handler` around a
handler, in the handler's fiber, and its `attemptEnded` once the worker is
done with an attempt. What the application needs to observe a run anywhere
travels with the run as its `headers`, which plans copy and never read, and a
claim says when its command was queued, due and claimed, by the store's clock.

### 4. Programs: what plans run (`src/program.ts`)

A program is a workflow's steps or a task's handler as plain functions over
**stored** values. The engine never sees a schema: the authoring layer
(`src/dsl/`) builds programs whose functions decode what they read and encode
what they return.

A durable workflow's program is a `replay` instead of steps: its body, run
whole and synchronously against a run's history in every pass, answering the
operations it came to and where it ended (`src/plan/durable.ts`). The pass
that runs it is a plan like any other, so a replay is planned again on a
conflict as any pass is, and needs no lease of its own: a send or a child's
end that lands during a pass voids it. Each operation is a node, kept with
what it was opened with (`StoredNode.operation`), and the work of a task or
workflow node is a child run, as a step's is. Its runs are workflow runs to
everything outside the pass.

An input sent to a durable run is a plan too (`src/plan/send.ts`): it writes
the input's node, completed with the value, in the sender's commit. Sent
before the body comes to it, the node waits there to be read; sent while the
body waits on it, the node it waits on is completed and the run woken. Its
deadline is the node's `until`, compared with the time the send is planned
at, as every plan reads time, so a value and the time running out are
ordered by what was stored, not by when a pass runs. A program also carries the description of its definition
(`src/graph/`): the graph, its hash, its labels, and for a revision its
manifest. The engine saves and compares these as text and never reads into
them.

## Conventions

- Records (`src/model.ts`) are written whole. A plan that changes a record
  writes its next version.
- User code the coordinator calls (`Compute`) is pure and synchronous. Code
  that waits or needs services is a handler (`Execute`) and runs in an
  attempt.
- Stored values are JSON.

## Tests

```sh
pnpm --filter @nmtjs/workflows test:unit
pnpm --filter @nmtjs/workflows test:integration
pnpm --filter @nmtjs/workflows test:e2e
```

Tests use `@effect/vitest`, so time is a `TestClock`: backoff, leases and
timeouts are tested by moving it, never by waiting. `tests/store-contract.ts`
is the contract every adapter passes. `tests/unit` runs it and the engine in
memory.

`tests/integration` needs a database. The PostgreSQL suites run on PGlite, and
on a server when `POSTGRES_URL` is set; the Redis suites run when `REDIS_URL`
or `VALKEY_URL` is set and are skipped otherwise. Its other suites drive the
built package through its exports, with real workers as fibers and as
processes of their own, on real clocks against the servers: crashes,
hand-overs, races, revisions across deployments, the caller's transactions.
Build the workspace first. Each server's variable runs its suites; with
`NMTJS_REQUIRE_SERVICE_TESTS=1` a missing one is an error instead of a skip.

`tests/e2e` builds and hosts the workers as Neem threads through its CLI; its
PostgreSQL cases run when `POSTGRES_URL` is set.
