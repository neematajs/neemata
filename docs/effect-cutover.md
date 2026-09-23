# Effect migration cutover

This is a deployment procedure for the clean-major migration, not a persisted-format
versioning feature. Existing retry, restart, and raw-history APIs remain available.
Complete the application proofs in [the migration plan](./effect-migration-plan.md)
before deleting the framework or deploying new writers.

## Preflight

Pin the application source, deployed package versions, target Effect version, and
backup used for rehearsal. Run the target SQL schema verifier against an isolated
restore. A successful SQL verification does not establish payload compatibility.

The current workflows adapter requires SQL schema version 3. A version-2 database
needs the [existing retry-accounting migration](../packages/workflows/README.md#schema-version-3-migration),
including `retry_attempt_number`, before the new adapter can start. This prerequisite
predates the Effect migration. Do not just change the version row.

Inventory all of the following under the old release:

- Root and child runs, grouped by kind, definition name, and status.
- Nodes, attempts, and node children, including completed outputs that a retry
  would read again.
- Every command: ready, delayed, leased, expired-lease, dead-lettered, and reaped.
  Record its payload shape and its linked run's status.
- Schedules and their stored input, plus every process that reconciles or fires them.
- Active run leases and attempts belonging to nonterminal runs. An old `started`
  attempt on a terminal run is historical state, not proof of a live worker.

Keep backup contents, identifiers, individual errors, and application-specific
inventory results local. Only aggregate findings belong in an assessment report.

## Check payloads and retained history

Test the actual release definitions against restored run input/output, node
input/output, attempt input/output, node-child input/output/item, schedule input,
and command payloads. Include branch-selected codecs and aggregate map/parallel
outputs. A generic JSON schema alone does not validate application compatibility.

Inventory defaults, optional keys, permissive fields, and transforms before choosing
fixtures. A schema made of JSON primitives can still reject older data after a
definition change. Inspect unconstrained fields separately: a JSON value recovered
from a backup does not prove that future handlers return only JSON values.

Compare decoded values and re-encoded JSON as well as acceptance. Applying a default
or stripping an obsolete key can change a round trip without introducing a new
Effect encoding. Assessment-only schema translations are useful probes, but the
checks must be repeated against the final application-owned Effect definitions.

Separate three operations:

| Operation      | Required compatibility                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read history   | Store/inspector can return the persisted JSON; current input and output codecs need not accept it.                                                                |
| Restart        | Terminal root run; matching **kind and name** in the management client's registry; stored root input decodes under that definition; uniqueness permits a new run. |
| Retry in place | Existing retry eligibility, plus compatibility of the graph, saved inputs, and every completed output the resumed run will decode.                                |

Exercise the real `restart()` API in a transaction or disposable database without
starting execution workers. A successful enqueue does not prove handler execution
or safe repetition of business effects. Validate every retained root input, not
only one example for each definition.

If a particular retained run is incompatible, preserve its history and document a
run-specific recovery decision. Reconstructing a new submission from authoritative
application records may be appropriate after checking duplicate side effects. A
workflow that became a task under the same name is not automatically the same
restart target. This procedure does not add a blanket legacy retry/restart ban.

## Pause submissions and drain

There is no assumed engine-wide pause switch. Establish and verify application or
ingress maintenance controls before cutover. Blocking new connections alone is
insufficient when existing RPC/WebSocket sessions can still submit work.

1. Block external submission paths, including API generation/backfills, chat and
   session interactions, workflow retry/restart, and direct administrative tools.
   Disconnect or drain existing submission-capable connections. Stop independent
   CLI/cron producers and suspend schedule firing/reconciliation. Check private
   endpoints as well as public ingress.
2. Let the old workers finish accepted work, including work that creates child
   runs or delayed follow-up tasks. Wait for delayed work or resolve it explicitly;
   an empty ready queue is not a drain.
3. Resolve nonterminal runs and dead-lettered commands under the old release.
   A terminal task may retain a continuation created by an older cancellation
   path. If normal workers cannot route it, a scoped maintenance operation may
   claim it, reload and verify its terminal task, then acknowledge it. Never clear
   the whole queue or acknowledge a command based only on its name.
4. Verify the drain at the database boundary. Stop every old worker and writer,
   then verify again. Reject a rollout with overlapping old and new writers.
5. Take a fresh, quiesced backup of the complete application database and record
   the binary/configuration needed to restore it. Apply required SQL migrations,
   run the target schema verifier, then start the new release with submissions
   still paused. Reopen ingress only after the application checks pass.

These read-only queries form part of the final check; they do not implement pause
or cancellation:

```sql
SELECT kind, status, count(*)
FROM workflow_runs
WHERE status NOT IN ('completed', 'failed', 'cancelled')
GROUP BY kind, status;

SELECT kind,
       CASE
         WHEN dead_at IS NOT NULL THEN 'dead'
         WHEN lease_token IS NOT NULL AND lease_expires_at > now() THEN 'leased'
         WHEN lease_token IS NOT NULL THEN 'expired lease'
         WHEN run_at > now() THEN 'delayed'
         ELSE 'ready'
       END AS state,
       reaped_at IS NOT NULL AS reaped,
       count(*)
FROM workflow_commands
GROUP BY kind, state, reaped;

SELECT count(*) FROM workflow_run_leases WHERE expires_at > now();
SELECT count(*) FROM workflow_schedules WHERE enabled;
```

The intended handover has no nonterminal runs, no executable old commands, no live
leases, and no enabled schedule producers. Prefer an empty command table. If dead
commands are retained, document their disposition and ensure no requeue/reaper
path can make them executable during handover. Reconciliation can re-enable stored
schedules, so disabling rows without stopping the producer is insufficient.

The maintenance control itself must be rehearsed against the actual deployment.
Source inspection and a local database drain do not demonstrate that control.

## Rollback

Before new writers run, rehearse reverting the SQL migration with the old adapter's
verifier. Compare all restored workflow tables to the preflight snapshot. Reversing
the version-3 retry-accounting migration requires reverting its column as well as
its version row; it is not a general rollback recipe after new execution.

After new writers run, do not assume that switching binaries is sufficient. Old
startup verification may reject the SQL schema even when sampled JSON remains
readable. Defaults and handler/type changes may also alter persisted values.

The conservative recovery is:

1. Pause submissions again and stop all new writers.
2. Capture the failed deployment's database before restoring anything, so accepted
   submissions and completed effects can be reconciled.
3. Restore the quiesced **full application** backup, restore compatible configuration
   and binaries, and verify the old SQL schema and application reads.
4. Reconcile submissions and domain changes after the backup boundary. Restore
   removes those database writes; it does not undo notifications, object-store
   operations, or other external effects. Review those before resubmitting work.

The data-loss window is every accepted write after that quiesced backup, unless
recovered by the reconciliation. A reverse conversion is an alternative only when
validated against the exact new representations and semantics. An isolated workflow
table restore proves neither full-application consistency nor external-effect recovery.

## Assessment status

An isolated restore exercise has covered SQL verification, payload comparisons,
retained-history reads and restart submissions, an old-release drain, and database
rollback. Snapshot-specific evidence is kept in the local assessment report.

This does not complete the real-application migration gate. The final Effect
definitions, database-backed handlers, retry and worker-restart proof, stream/upload
proof, and actual deployment maintenance control still need validation. Stored-format
markers and definition-version enforcement remain deferred.
