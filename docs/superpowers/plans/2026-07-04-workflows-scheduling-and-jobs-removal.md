# Workflows-native scheduling + removal of packages/jobs and packages/scheduler

Decision (2026-07-04): `@nmtjs/workflows` supersedes `@nmtjs/jobs`. Both
`packages/jobs` (BullMQ/Redis job queue) and `packages/scheduler` (BullMQ
repeatable-job cron scheduling built on jobs) are removed entirely, and
recurring scheduling is re-implemented natively in the workflows postgres
runtime — designed fresh, not ported from BullMQ semantics.

Deliberately NOT ported from jobs (no real consumer uses them; workflows
stays free of `@nmtjs/application`): `jobsPlugin`/`jobRouter` RPC generation,
progress schema/reporting, user-facing priority, manual retry/remove-by-id.
Apps that want RPC exposure hand-write thin procedures over
`WorkflowRuntimeClient`.

## Slice G — removal (mechanical, first)

Inventory (verified 2026-07-04):

1. Delete `packages/jobs` (~3.5k lines, bullmq/ioredis/iovalkey deps) and
   `packages/scheduler` (~1.6k lines; hard dependent on jobs internals:
   `getJobQueueName`, `resolveJobsClient`, `JobManager`, `QueueJobRunner`).
2. `packages/nmtjs` umbrella: remove `@nmtjs/jobs` dependency; in
   `src/index.ts` remove the re-export block (`job`, `step`, `jobRouter`,
   `jobOperation`, `jobsPlugin`, `JobInjectables`) and the
   `...JobInjectables` spread in the exported `inject` map. Update
   `tests/exports.spec.ts` expectations accordingly.
3. Root `tsconfig.json` + `tsconfig.build.json`: drop project references to
   `packages/jobs` and `packages/scheduler`.
4. Root `package.json` `test:integration:services`: drop
   `--filter @nmtjs/jobs --filter @nmtjs/scheduler`.
5. CI `.github/workflows/test.yml`: NO service changes — redis stays for
   pubsub/eventing, valkey stays for pubsub/eventing (`VALKEY_URL` used by
   their integration helpers).
6. `pnpm install` to refresh the lockfile.
7. Skills sweep (now legitimate — the APIs are gone):
   - `skills/use-neemata`: delete `references/jobs.md`; drop the Jobs line
     and the `jobs` description keyword from `SKILL.md`; purge jobs symbols
     from `references/api-reference.md` (export list + `/neem` subpath +
     API summary), `references/server-setup.md` (`jobsPlugin` example),
     `references/injectables.md` (`JobInjectables`).
   - `skills/use-neem`: replace jobs-based examples in
     `references/package-integration.md` and `references/runtimes.md` with
     workflows equivalents (`createWorkflowsRuntime`, `defineWorkflowsPlanner`,
     `defineWorkflowsWorker`).
8. Dated design records under `docs/superpowers/specs/` stay untouched.

## Slice H — native scheduling

### Model

New table `workflow_schedules` (schema manifest v4; drizzle + testing kept in
sync):

- `id` uuid PK, `name` text UNIQUE — the schedule identity.
- `runnable_kind` (`workflow` | `task`), `runnable_name` text.
- `input` jsonb (schema-encoded at reconcile), `tags` jsonb.
- `cron` text NULL, `every_ms` bigint NULL — exactly one set.
- `enabled` boolean, `next_run_at` timestamptz, `last_slot_at` timestamptz NULL,
  `created_at`, `updated_at`.
- Index `(enabled, next_run_at)` for the due scan.

Code is the source of truth: schedules are declared statically and reconciled
at worker startup — upsert by name, delete DB rows absent from config
(cutover semantics; no continuity/handoff knobs). Reconcile is guarded by
`pg_advisory_xact_lock` and idempotent, so concurrent coordinator threads are
harmless.

### Firing

Tick runs as a coordinator-loop side-duty, same shape as the retention prune
in `runtime/worker/loop.ts` (throttled, non-reentrant; default `everyMs`
1000, configurable). Each tick, in one transaction:

1. `SELECT ... WHERE enabled AND next_run_at <= now() FOR UPDATE SKIP LOCKED
   LIMIT batch`.
2. Per row: start the run in-transaction (postgres adapter pattern:
   `createPostgresWorkflowRuntime({ connection: tx })`) with
   `idempotencyKey: ['$schedule', name, slot.toISOString()]` (slot =
   `next_run_at`) and tags merged with `{ schedule: name }`.
3. Compute `next_run_at` = next occurrence strictly after `now()` — missed
   slots are skipped, never backfilled; set `last_slot_at = slot`.

Exactly-once per slot = row lock (SKIP LOCKED) + slot-derived idempotency key
as the safety net. Cron parsing via `cron-parser` (regular dependency);
`every` intervals use `DurationString`.

### Public API

- Root: `defineSchedule({ name, runnable, input, cron? | every?, tags?,
  enabled?, immediately? })` — `runnable` is a task or workflow definition;
  `input` validated/encoded against its input schema at reconcile.
  `immediately: true` seeds `next_run_at = now()` instead of the next
  occurrence.
- Runtime adapter: optional `scheduler` object (both adapters; in-memory
  mirrors) with `reconcile(entries)` and `fireDue({ now, limit })`;
  `runWorkflowWorker` gains `scheduling?: { everyMs?, batchSize? }`.
- Client: `client.schedules.list()`, `client.schedules.trigger(name)` (fire
  now, slot = now), `client.schedules.setEnabled(name, enabled)`.
- Neem: `defineWorkflows({ schedules?: () => [...] })`; coordinator
  worker-entry reconciles at startup and enables the tick.
- Delayed start (independent but bundled):
  `WorkflowRuntimeStartOptions.startAt?: Date`. Workflow runs enqueue their
  first continue via the existing delayed path (`enqueueDelayed` / `run_at`);
  task runs insert the task-attempt command with `run_at = startAt`. Run row
  exists immediately (visible in `get`/`list`).

### Tests

- Unit (both adapters): reconcile upsert/delete/disable, due firing, slot
  idempotency (double fire → one run), cron + every next-occurrence math,
  `immediately`, trigger, startAt for workflow and task starts.
- Integration (postgres, existing harness): schedule fires exactly once
  across 3 concurrent coordinator workers; disable stops firing; missed
  slots skipped after downtime (manipulate `next_run_at`); startAt delays
  visibly.

## Slice I — playground port

- Delete `apps/neemata/src/runtimes/jobs/`; drop `@nmtjs/jobs` from both
  package.json files (redis stays — pubsub/eventing use it).
- In `runtimes/neemata/api.ts`: remove the `jobRouter` mount and dead
  `jobsPlugin` comment block; re-express the `job` demo procedure over the
  existing workflows runtime client (start + wait/get).
- After Slice H lands: add one `defineSchedule` example to the workflows
  runtime config.

## Sequencing and verification

G → H → I; each slice: `pnpm build`, `pnpm check:type`, `pnpm check:lint`,
`pnpm vitest run packages/workflows` (+ full affected unit suites),
integration ×3 against local postgres, then commit. Playground verified with
`pnpm run check:type` (tsgo) in neem-playground. No regression tests
asserting the old APIs are gone — the compiler is the referee.
