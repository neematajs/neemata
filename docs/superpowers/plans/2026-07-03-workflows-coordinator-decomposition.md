# Workflows Coordinator Decomposition Plan

## Goal

Split `src/runtime/coordinator.ts` (~2.6k lines) and `src/runtime/worker.ts`
(~1.2k lines) into single-responsibility modules without any behavior change
and without touching the public surface of `@nmtjs/workflows/runtime`.

## Decisions

- `coordinator.ts` and `worker.ts` become barrels (re-export only), so
  `runtime/index.ts` and `runtime/client.ts` imports stay byte-identical.
- The advance→dispatch→advance recursion is broken via an `advance` function
  carried on the context object (wired once in the continuation entry), not
  via ESM import cycles.
- Two context shapes get named: `RuntimeDeps` (`store` + both executors) and
  `AdvanceCtx` (`RuntimeDeps` + workflow, workflowCtx, run, outputs, advance).
- Pinning tests land BEFORE the moves they protect (see Risk register).

## Target layout

```
runtime/
  coordinator.ts            barrel
  coordinator/
    context.ts              RuntimeDeps, AdvanceCtx, user-callback error family
    start.ts                startWorkflowRun, startTaskRun, start metadata/ctx
    continuation.ts         continueWorkflowRun (guard ladder), lease fence,
                            lease renewal
    advance.ts              advanceWorkflowRun (node ladder + finish + user-error catch)
    sinks.ts                complete/fail/cancel RunAndWakeParent, failNodeAndRun,
                            cancelNodeAndRun, failMissingChildRun
    cancel.ts               cancelRunTree, sibling cancel, fan-in cancel policy
    children.ts             dispatchChildTaskRun, dispatchChildWorkflow
    attempt.ts              dispatchPreparedAttempt + activity/task/taskRun wrappers
    codec.ts                decode helpers, resolveIdempotency, node-declaration lookup
    dispatch/{task,workflow,activity,branch,parallel,map}.ts
  worker.ts                 barrel
  worker/
    loop.ts                 runWorkerLoop, sleep, concurrency, error predicates
    entry.ts                runWorkflowWorker/runActivityWorker/runTaskWorker
    atomic.ts               runAtomicCompletion/Continuation
    heartbeat.ts            runWithAttemptHeartbeat (heartbeat + timeout race, one unit)
    activity-attempt.ts     runActivityAttempt + resolve helpers
    task-attempt.ts         runTaskAttempt
    reconcile.ts            reconcileStaleAttempt, freshness, terminal ack
    retry.ts                retry core, shouldRetryAttempt, backoff
```

## Migration sequence (each step ends green)

1. `coordinator/codec.ts` — pure move (~130 LOC).
2. `coordinator/context.ts` — error classes + `runWorkflowUserCallback` only.
3. `coordinator/sinks.ts` — pure move.
4. `coordinator/cancel.ts` — pure move.
5. `coordinator/attempt.ts` — pure move.
6. `worker/` leaf modules (loop, atomic, heartbeat, retry, reconcile) — pure
   moves, one file at a time; worker is lower-risk and proves the barrel
   pattern first.
7. `worker/activity-attempt.ts`, `worker/task-attempt.ts`, `worker/entry.ts`;
   `worker.ts` → barrel. Worker done.
8. Introduce `RuntimeDeps`/`AdvanceCtx` + `ctx.advance` threading **in place**
   inside coordinator.ts (still one file) — the only signature-change step;
   keep it an isolated, reviewable diff.
9. `coordinator/dispatch/*` + `children.ts` — pure moves, one node kind at a
   time.
10. `advance.ts`, `continuation.ts`, `start.ts`; `coordinator.ts` → barrel.
11. Optional: shared `runtime/codec.ts` for the duplicated plain
    `decodeSchemaValue` (coordinator's stays user-callback-wrapped — the two
    error-routing regimes must not merge).

## Risk register — pin these behaviors with tests before moving

- **Lazy thunks**: input/idempotency resolvers must stay `() =>` params;
  add tests asserting the idempotency mapper is NOT invoked when a child
  link already exists (workflow + activity variants; task variant exists),
  and that input decode precedes idempotency resolution.
- **Guard-ladder order** in `continueWorkflowRun` (cancelling → terminal →
  failed-node → cancelled-node → advance): add tests for runs satisfying two
  guards at once (cancelling+failed-node ⇒ cancel wins; failed+cancelled
  node ⇒ fail wins).
- **User vs infra error routing**: add a test that an infra (store) error
  inside a dispatcher propagates and does NOT become failNodeAndRun.
- **Lease-fence completeness**: `createRunLeaseFencedStore` enumerates ~22
  mutating methods by hand; add a spy test asserting every mutating store
  method renews the lease first. Do NOT replace with a Proxy (read-only
  methods are intentionally unfenced).
- **Atomic transaction capture** (worker): all completion/retry/reconcile
  writes must go through the `scoped` store from `runAtomicCompletion`; add a
  marker-store test before splitting attempt/reconcile modules.
- **Activity dispatcher normalization**: it takes `runId`+`workflowInput`
  today; folding into `ctx.run` is safe (single call site passes
  `run.id`/`run.input`) — add a pin test that the activity input mapper
  receives `run.input`.
- **Heartbeat/timeout race**: keep `runWithAttemptHeartbeat` as one unit; the
  detached `work.catch(() => {})` and race membership are load-bearing.
- Add a worker test: stale-attempt reconcile for a `task`-kind run
  (attempt completed, node not) completes the run and wakes the parent.

## What NOT to do

- No generic `NodeDispatcher` interface/table — the 7 node kinds genuinely
  differ; keep the explicit ladder in `advance.ts`.
- No merge of `dispatchChildTaskRun`/`dispatchChildWorkflow` — same shape,
  fundamentally different non-terminal actions; extract only identical tails.
- Map dispatchers are already minimal adapters over the merged engine.
- No Proxy-based lease fence.
- Never eagerly resolve input/idempotency thunks while threading contexts.
