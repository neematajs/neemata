# Redis adapter

`Store` on Effect's `Redis` service (`effect/persistence/Redis`). It needs that
service and nothing else, so any driver that provides one serves; Valkey is
Redis here.

```ts
import { NodeRedis } from '@effect/platform-node'
import * as Redis from '@nmtjs/workflows/redis'

const store = Redis.layer({ prefix: 'billing:', maxDeliveries: 20 }).pipe(
  Layer.provide(NodeRedis.layer({ url })),
)
```

A store holds its driver's command connection and one subscription, which a
driver may give a connection of its own.

Tested on Redis 8 and Valkey 9. It uses no command newer than Redis 5.

## How a commit is guarded

Redis has no rollback and a script cannot call a plan, so nothing is held
while a plan runs:

1. One script reads what the scope names, the server's time, and a revision
   for every guard: each run, key, definition, schedule and dead command, the
   set of schedule names, each family. A revision is the token of the commit
   that last wrote the thing, and nothing when the thing is absent. A
   family's is its root's with its two counts, a dead command's the token of
   the claim that set it aside.
   A unit is read as fields of its run's hash, by name: the run, the node
   with its input, the child, and the attempt the unit names or the child's
   current one, whose id is kept beside the child. Its revision is its
   run's.
   A run opened is read by its indexes: the names of its nodes, then each
   node by name, a map's without its input, and of each that has not ended
   the children it waits on. A map's come from two sorted sets by ordinal,
   those under way all and those waiting as far as the window asked and one
   more, which tells whether more wait and is read no further; any other
   node's from the set of all its children. Then each child read by name,
   its current attempt, and the run it started, kept beside it, when it has
   not ended: that run's head and revision, which is checked at the commit
   as a head's.
   A node's results are the node with its input and its children from the
   set of all of them, by ordinal. Nothing is read by `HGETALL` but a run
   loaded whole. Both are guarded by the run's one revision. A run stored
   without these indexes is never read as one whose indexes are empty: the
   read fails with `StorageError`.
2. The plan runs in the process, on that snapshot. What its mutation writes
   of what runs own is checked against what was read, before the commit is
   sent: a run loaded whole or created, or else what a unit, an open read or
   a results read found, what an open read found absent, and attempts with
   an id of this read under a child it may write; a child only of a node
   that is there or written with it, as the indexes of a run are found by
   its nodes; an ordinal only as an integer.
3. One script commits. It first checks everything and writes nothing:
   every guard still has the revision that was read, every claim it
   acknowledges or must hold is still held by the server's clock, every run
   written that the plan did not read is absent, guarded or not, every run that owns a written record exists, every
   definition written is absent, every node written but for its input is
   there, every number it is to write is one, an ordinal an integer. Only
   then does it write everything: the records, keys,
   definitions, schedules, removed families, the queue, the indexes, the
   revisions, and the hints it publishes. A child written is filed in the
   indexes of its node by where it now stands, and its run's revision moves
   with them. A node written but for its input keeps the input field as it
   is.

A commit that finds a guard changed has written nothing, and is planned again
on a fresh read, after a short random wait that grows with each loss. After
`maxAttempts` losses (32) `transact` fails with `StorageError`: every loss
means another commit went through, so only a run written to without pause
starves its other writers. `Need` reads more and plans again without counting.

A script runs alone on the server, so each of the two is atomic. A server out
of memory refuses a script before its first write, never between two.

A token is a random id the process makes for each commit and each claim, each
time one runs, and gives to the script. The server counts none of them: after a failover a
replica is promoted with the state it had at an earlier moment, and a counter
kept there would go back with the rest and give a later writer the revision,
or a later claimant the claim, that someone still holds from before. A token
of before never comes again, so a plan made on lost state is planned again,
and a claim on lost state is stale.

## Time

Every time is the server's (`TIME`): `snapshot.now`, the end of a lease, when
a command is due. No clock of a worker is read.

## Keys

Every key is `{<prefix>}<name>`. The prefix in braces is a hash tag, so a
Redis Cluster keeps the whole store in one slot, which the scripts need: a
commit writes indexes that span the store. Stores with different prefixes go
to different slots. The scripts are given that root as their one key and
build the others from it, all in the slot of the one given: a cluster
allows that, a proxy that must be told every key does not. The prefix may not be
empty nor hold a brace, and `make` dies if it does. The suite passes on a
node in cluster mode; a cluster of several nodes was not tried.

| Key                                             | Holds                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run:<id>`                                      | hash: the run (`run`, and its payloads apart in `io`), its nodes without their input (`N…`), their inputs (`I…`), whether each is a map's and has ended (`S…`), children (`C…`) with the id of their current attempt (`U…`), attempts (`A…`), its revision, `indexed`, and what the indexes need to find it again |
| `run:<id>:nodes`                                | set: the names of the run's nodes                                                                                                                                                                                                                                                                                 |
| `run:<id>:all:<node>`                           | sorted set: the fields of a node's children, by ordinal                                                                                                                                                                                                                                                           |
| `run:<id>:pending:<node>`, `…:active:<node>`    | sorted sets: of a map's children, those waiting and those under way, by ordinal                                                                                                                                                                                                                                   |
| `runs:<term>`                                   | sorted set: the runs a filter may name, in the order of all lists of runs                                                                                                                                                                                                                                         |
| `roots:<status>`                                | sorted set: root runs of a status, the longest unchanged first                                                                                                                                                                                                                                                    |
| `keys`, `held:<runId>`                          | identity keys with their holder, and the keys each run holds                                                                                                                                                                                                                                                      |
| `definitions`                                   | saved definition records                                                                                                                                                                                                                                                                                          |
| `schedules`, `schedules:names`, `schedules:due` | schedules, their names in order, and the enabled ones by `nextRunAt`                                                                                                                                                                                                                                              |
| `command:<id>`, `commands:<runId>`              | a command, and the commands of each run                                                                                                                                                                                                                                                                           |
| `due:<lane>`, `wait:<lane>`                     | sorted sets: the commands of a lane that may be claimed, in queue order, and those waiting for a time                                                                                                                                                                                                             |
| `waiting:<dedupe>`                              | sorted set: the unclaimed commands that wait under a dedupe key, by their turn                                                                                                                                                                                                                                    |
| `claims:<runId>`                                | the claims on a run's commands, by the end of their lease                                                                                                                                                                                                                                                         |
| `dead`, `dead:active`, `dead:run:<runId>`, …    | dead commands in the order they were set aside: all, those of runs not ended, those of one run; `dead:key:<dedupe>` finds the ones a command queued again takes away                                                                                                                                              |
| `meta`                                          | the turns of runs, of commands and of dead commands, which only order them, and the revision of which schedules exist                                                                                                                                                                                             |
| `hints` (a channel)                             | hints of commands that became due and of notified topics                                                                                                                                                                                                                                                          |

A run's place in a list is `createdAt`, then its turn among all runs, as
text that sorts the way the list is ordered. Every `runs:<term>` index holds
that same text, so a cursor is a place in all of them.

## Reads

Nothing scans the keyspace. `runs` has an index for everything a filter can
name by equality: kind, name, revision or none, status, parent or none, root,
each tag. The script reads the smallest of those the filter names (a filter of
several statuses reads theirs together), from the cursor, and the adapter
applies the whole filter to what comes back, a batch at a time. So a filter
that names something rare is cheap, and `activeBefore`, `input`, and whatever
the chosen index does not cover cost what that index holds. `createdBefore`
is where the read starts.

`dead`, `claimed`, `schedules`, `prunable` and families are each read from
their index. A family's `claimedRunId` asks every run of the family.

## The queue

A command is queued in the lane of its kind, name and revision; a route
without a revision is a lane of its own. A claim asks the lanes given for
their first due commands and takes the first of them all, so the order is
that of queueing across lanes. Claim, renew and release are one script each.

`maxDeliveries` and `maxAttempts` are positive integers, and `make` dies when
one is not.

Hints go over one pub/sub channel per store, published by the script that
made a command due. They are only hints: one published while the subscriber
was reconnecting is lost, and workers find the work by polling.

## Limits

- **A commit is one script argument**, the mutation as JSON, and the server
  does nothing else while the script runs. On a local server a commit that
  creates a run with N child runs, their N child records and N commands
  takes about 0.1 s for 1 000, 0.5 s for 10 000 and 2 s for 50 000; removing
  such a family takes under half of that. Keep a fan-out to tens of
  thousands of items. Past `busy-reply-threshold` (5 s by default) the
  server answers other clients with `BUSY`; one argument may not exceed
  `proto-max-bulk-len` (512 MB by default).
- **Records are opaque to the scripts.** They travel as text and are stored
  as given, so numbers keep their precision and the depth of a payload is
  not limited by Lua. No script decodes a record: what one must know of it,
  where a child stands or which attempt is current, the adapter puts beside
  it.
- **Memory.** Run the server with `maxmemory-policy noeviction`: an evicted
  key is half a run. History stays until `prunable` and a plan remove it; no
  key expires. Every run costs its records and about ten index entries, and
  every child one entry, a map's item one more while it waits or is under
  way.
- **Durability is the server's.** A commit is acknowledged when Redis has
  applied it, not when it is on disk or on a replica: with `appendfsync
everysec` a crash may lose the last second, and a failover may lose what a
  replica had not received. The engine then sees an older, consistent state:
  what was read or claimed before it is void, as the tokens tell. The turns
  that order runs and commands are still counted by the server and may be
  given again, and the id of a command is its turn: an id of before the
  failover may then name another command.
- A storage failure is a `StorageError`. One that comes while a script is in
  flight leaves it unknown whether the script ran, as the contract says.

## Moving from the Promise engine

The Redis data of the Promise engine (`@nmtjs/workflows` up to
`0.18.0-alpha.4`, its last release, called the old engine here) has other shapes, and is not converted: its runs
in flight are its own to finish. The two engines share no key, even under one
prefix: every key here begins with a brace, and none of the old engine's
does.

1. Stop starting runs on the old engine and let it finish, or cancel, what
   it has: every run ended, no command queued or claimed.
2. Stop every process of the old engine.
3. Start the new engine. It begins empty.

What that leaves behind:

- **History is not carried over.** The old engine's ended runs stay under
  its keys and expire as it set them to (`terminalRetentionMs`, 15 minutes
  by default). The new engine does not list them.
- **Identity is not carried over.** A start that repeats an idempotency or
  unique key of an old run creates a new run.
- **Nothing else expires.** The old queues (`<prefix>queue:continue:*`,
  `<prefix>queue:attempt:*`, dead commands included) and the
  `<prefix>runs:sequence` counter stay: delete them, and whatever else is
  left under `<prefix>` without a brace, once the old history is no longer
  wanted. The old prefix defaulted to `nmtjs:workflows:`.
- **Definitions** were never the old Redis adapter's: the new engine saves
  them as runs of a revision start.
- **Schedules** were never the old Redis adapter's; the new engine
  reconciles those it is given.
