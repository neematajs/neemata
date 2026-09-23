# To-do

Work that is known and deliberately not done yet. It is independent of the Effect
migration unless a section says otherwise; that migration's remaining steps live in
[effect-migration-plan.md](effect-migration-plan.md).

## Workflows

- **Cluster-wide limits.** Pool `concurrency` is capacity per process: three
  instances of a two-slot pool run six handlers. Nothing can say "at most four
  Stripe calls anywhere" or "at most fifty checkout runs in flight".
  - Only tasks and workflows carry limits, as with pools; an activity that needs
    one becomes a task.
  - A handler names a limit the way it names a pool (`limit: 'stripe'`); values
    are declared once beside the pools, since they differ per environment and
    several handlers may share one.
  - Enforce it where workers claim work: count running attempts per limit under a
    per-limit lock, in both adapters. Only running attempts hold a slot; one
    waiting out a retry backoff holds nothing.
  - The claim must skip commands whose limit is full, or one saturated limit
    stalls everything else in its pool.
  - One limit per handler, so no lock ordering exists to get wrong.
  - A workflow's `runs` limit needs a "queued, not admitted" run state and must
    admit root starts only: a child counted against a limit its waiting parent
    holds deadlocks once the limit is full.
- **Fairness and priority.** Workers claim by `priority`, then age, without regard
  to the run. One run's 10k-item map starves every other run in its pool. The
  queue's `priority` column exists but nothing exposes it.
- **Stored-format versioning.** Stored values carry no format or definition
  version. Decide how a worker recognises a run written under other definitions,
  and the policy for retrying or restarting older runs. A graph hash can detect
  node insertion or reordering for in-flight runs; it does not version handler
  behaviour or schemas.
- **Registry checks outside Neem.** Unregistered child workflows and tasks, and a
  name carried by more than one definition object, fail startup only in the Neem
  workers (`resolveWorkflowsRegistry`). `runWorkflowWorker`/`runExecutionWorker`
  accept partial registries, which many tests rely on; offer the checks as an
  explicit call for standalone hosts.
- **Errors raised after an abort.** `finish` runs with an abort signal. A Promise
  `finish` that rejects with its own error once aborted is reported through
  `onError`, although the run is only being released. Attempts already normalise
  this to the abort reason; continuation does not.
- **Non-finite numbers in untyped outputs.** A workflow without an output schema
  now rejects `NaN` and `Infinity`, which JSON would turn into `null`. No test
  covers it.

## Neem

- **Configurable stop deadline.** A worker gets a hard 5,000 ms to stop, shared by
  an unfinished factory and all finalizers. A workflows pool's `cleanupTimeoutMs`
  cannot extend it, so a longer value only changes when the thread is recycled
  while running, not on deploy.
- **Confirm that a failed worker start aborts boot.** The workflows workers rely on
  it to reject an undeclared pool or an incomplete registry at startup. It held
  when the startup-stop change was reviewed; no test pins it for this case.

## Metrics

- Narrow `@nmtjs/metrics` to Neem host and worker observation once the retired
  framework is deleted, and decide whether the forked `@nmtjs/prom-client` is still
  needed. Applications can export their own metrics from workers through OTLP.

## Effect preset (`@nmtjs/effect`)

These two concern the Effect adapter rather than the migration itself.

- **Logging bridge.** Effect logs are not routed into Neem's Pino logger;
  applications receive `ctx.logger` and configure Effect logging themselves.
- **Complete Cause diagnostics.** A worker failure with a single cause keeps its
  identity and several are rendered with `Cause.pretty`, but structured causes
  (parallel failures, finalizer defects) are not preserved for the host's logs.
