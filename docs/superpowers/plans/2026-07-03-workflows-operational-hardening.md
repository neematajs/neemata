# Workflows Operational Hardening Plan

Research-backed roadmap for the four operational gaps plus AbortSignal
cancellation delivery and integration-suite flake margins. Prior art surveyed:
Temporal, DBOS Transact, Inngest, pg-boss, graphile-worker, River, Oban.

## Ranking (value-for-effort, pre-release)

1. Continue-command coalescing — S
2. Terminal-run retention/GC — M (the "grows forever" prod killer)
3. Dead-letter/poison handling — M-L
4. Dashboard indexes — S-M (tree indexes now, status/name deferred)

AbortSignal delivery is orthogonal and can ship independently.

## 1. Continue-command coalescing (manifest v3)

At most one UNCLAIMED `continue` per run (graphile-worker `job_key` replace /
Inngest debounce semantics). A leased continue does not block a fresh enqueue,
so events arriving mid-processing still force re-evaluation after ack.

```sql
CREATE UNIQUE INDEX workflow_commands_continue_dedup_idx
  ON workflow_commands (run_id)
  WHERE kind = 'continue' AND lease_token IS NULL;
-- enqueue/enqueueDelayed become:
INSERT ... ON CONFLICT (run_id) WHERE kind='continue' AND lease_token IS NULL
DO UPDATE SET run_at = LEAST(workflow_commands.run_at, EXCLUDED.run_at),
              payload = EXCLUDED.payload;
```

`LEAST(run_at)` keeps an immediate wakeup from being delayed behind a pending
delayed one. Mirror the semantics in the in-memory executor. All ~12 coordinator
enqueue sites are idempotent re-evaluations — no path relies on multiple
pending continues (verified).

## 2. Terminal-run retention / GC (no schema change)

Batched DELETE of terminal ROOT runs; FK cascade removes the whole tree
atomically (deleting a child alone would orphan the tree).

```sql
DELETE FROM workflow_runs WHERE id IN (
  SELECT id FROM workflow_runs
  WHERE parent_run_id IS NULL
    AND status IN ('completed','cancelled','failed')
    AND updated_at < $cutoff
  ORDER BY updated_at LIMIT $batch
  FOR UPDATE SKIP LOCKED
) RETURNING id;
```

API: `store.pruneTerminalRuns({ olderThan, statuses?, batchSize? })` + a client
helper looping until a short batch. Execution options (no daemon exists):
explicit app cron via client API, and/or ride the worker idle loop guarded by
`pg_try_advisory_xact_lock(hashtext('workflow_prune'))` so one worker prunes.
Retention is OPT-IN with a conservative default (7-30 d) — a workflow engine
holds audit state, unlike job queues (Oban default 60 s, River 24 h,
Temporal 72 h). Keep batches small (dead-tuple/WAL bound); document
pg_partman-style partitioning as the future scale-out (blocked today by the
uuid-only PK and apps-own-migrations).

## 3. Dead-letter / poison commands (manifest v3)

Quarantine-in-place (DBOS `MAX_RECOVERY_ATTEMPTS_EXCEEDED` / River-Oban
`discarded` model). Today a poison continue requeues every fixed 50 ms forever
and `release()` never sees the error.

- Columns on `workflow_commands`: `delivery_count int NOT NULL DEFAULT 0`,
  `last_error jsonb`, `dead_at timestamptz`.
- `release(error?)`: increment count, store error, exponential backoff
  `LEAST(2^count * 50ms, 5m)` replacing RELEASE_BACKOFF_MS, set `dead_at`
  at `maxDeliveries` (generous default ~20).
- Claim predicate gains `AND dead_at IS NULL`; dead rows stay inspectable.
- `store.listDeadCommands()` + `store.requeueDeadCommand(id)`; retention
  (item 2) sweeps old dead rows.
- Coalescing (item 1) already caps the pileup — lowers urgency, not need.

## 4. Operational indexes (manifest v3)

Ship now (near-free, closes real seq-scans on tree navigation):

```sql
CREATE INDEX workflow_runs_parent_idx ON workflow_runs (parent_run_id)
  WHERE parent_run_id IS NOT NULL;
CREATE INDEX workflow_runs_root_idx ON workflow_runs (root_run_id);
```

Defer until a dashboard consumes `listRuns` (write-amp on every status
transition; consider partial per-state indexes a la Oban):

```sql
CREATE INDEX workflow_runs_status_created_idx
  ON workflow_runs (status, created_at DESC, id DESC);
CREATE INDEX workflow_runs_name_created_idx
  ON workflow_runs (name, created_at DESC, id DESC);
```

Confirm `listRuns` cursor decodes to `(created_at, id)` keyset pagination.

Items 1, 3, 4 can share ONE manifest bump to v3 (index + columns + verify +
drizzle + testing DDL together).

## 5. AbortSignal delivery to handlers

One `AbortController` per attempt inside `runWithAttemptHeartbeat`, aborted
with a typed reason from four sources:

| reason      | source                         | disposition after abort                                                         |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------- |
| `timeout`   | existing timer                 | attempt `timedOut` (use the enum; today recorded as `failed`), retry per policy |
| `leaseLost` | existing heartbeat zero-row    | abandon, no terminal write                                                      |
| `cancelled` | NEW: heartbeat piggyback       | ack-drop, no retry; coordinator finalizes                                       |
| `shutdown`  | worker-loop signal threaded in | release command, no terminal write                                              |

- Cancellation observation: extend the heartbeat UPDATE with
  `RETURNING (SELECT r.status FROM workflow_runs r WHERE r.id = c.run_id)` —
  one PK lookup on a query already running every leaseMs/3; latency ≤ leaseMs/3
  (Temporal's model: cancellation is delivered via heartbeat). Heartbeat
  return type becomes `{ runStatus }`. Do NOT make cancel touch claimed
  commands — lease expiry means "hand off", the wrong semantic for cancel.
- Handler API: additive third arg `(ctx, input, lifecycle?: { signal })` —
  2-arg handlers remain assignable (graphile-worker precedent). Do not put the
  signal on `ctx` (frozen, dep-derived typing).
- Cooperative only: handlers that ignore the signal behave exactly as today.
- Shutdown source also fixes graceful drain: neem `stop()` currently waits for
  blocked handlers with no way to tell them.

## 6. Integration-suite flake margins (test-only)

Audit verdict: the 1-in-19 failure is almost certainly the heartbeat
keep-alive scenario — the only test whose assertion (`calls === 1`) has no
fencing safety net, with a 90 ms lease / 30 ms heartbeat (60 ms slack, one
DB round-trip per beat, skip-guard while one is in flight) and a stealer
polling for the whole 240 ms handler.

- Heartbeat scenario: `leaseMs 90 → 180`, handler `wait 240 → 360` (still 2x
  lease, still proves renewal; slack doubles), stealer `idleDelayMs 40 → 80`.
- Crash-redelivery: `wait(120) → 150`.
- Others: fencing/barrier-protected, leave as-is.
- Production-side follow-up: schedule heartbeats on elapsed time instead of
  skipping ticks while one is in flight, and default the lease to a larger
  multiple of the heartbeat interval.
