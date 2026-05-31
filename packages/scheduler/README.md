# @nmtjs/scheduler

`@nmtjs/scheduler` registers BullMQ job schedulers for Neem jobs. It only
owns schedules. It does not own job execution, job queues, or queued job
retention.

## Runtime model

Use `defineSchedulerRuntime()` from `@nmtjs/scheduler/neem` to add a scheduler
runtime to a Neem app:

```ts
import { defineSchedulerRuntime } from '@nmtjs/scheduler/neem'

export default defineNeemConfig({
  runtimes: {
    scheduler: defineSchedulerRuntime({
      config: '@app/scheduler',
    }),
  },
})
```

The scheduler runtime is host-only. It starts in the Neem host process, loads
the scheduler config artifact, resolves the jobs client, and reconciles the
declared schedules against BullMQ.

## Scheduler config

```ts
import { defineScheduler } from '@nmtjs/scheduler'

export default defineScheduler({
  client,
  jobs: () => [jobs.echo],
  schedules: () => [
    {
      id: 'echo-every-minute',
      job: jobs.echo,
      data: { message: 'scheduled echo' },
      repeat: { every: 60_000, immediately: true },
      options: { removeOnComplete: true, removeOnFail: true },
    },
  ],
  handoff: 'continuity',
})
```

Each schedule maps to one BullMQ job scheduler. The BullMQ scheduler id is
`<runtime-name>:<schedule-id>`. The queue name comes from the job definition,
so scheduled jobs use the same queue as jobs added manually.

## Deployment authority

Run one scheduler instance per deployment, Redis namespace, and runtime owner.
The package does not implement distributed leader election or a deployment
lock.

The scheduler is designed as the single authority that reconciles scheduled
jobs for its runtime owner. Job workers can scale independently, but scheduler
replicas should not scale horizontally unless external coordination ensures
only one active reconciler.

If multiple scheduler instances run against the same owner and Redis data, they
can race while reconciling, removing stale schedules, or applying `cutover`
handoff. If multiple owners configure the same logical schedule, BullMQ treats
them as distinct schedulers and duplicate scheduled jobs can be produced.

## Reconciliation

On start, the runtime:

1. Resolves `client`, `jobs`, `schedules`, and `handoff`.
2. Creates BullMQ `Queue` instances for the queues referenced by schedules.
3. Validates each scheduled job exists in `jobs`.
4. Upserts each schedule through BullMQ `upsertJobScheduler()`.
5. Removes owned schedules that existed before but are not declared now.
6. Stores a small ownership index of `{ queueName, schedulerId }` entries.

The ownership index is required because BullMQ scheduler discovery is
queue-scoped. If a deployment removes the last schedule for a job, current
config no longer contains the old queue name, so the scheduler needs this index
to find and remove the old BullMQ scheduler.

The index is not a job registry. Unscheduled jobs from `jobs()` are ignored.

## Handoff

`handoff: 'continuity'` is the default. Reconcile upserts current schedules and
removes stale owned schedules without clearing existing schedules first.

`handoff: 'cutover'` removes owned schedules before start reconciliation and
again on normal stop. Failure cleanup does not remove owned schedules, so a
crashing runtime does not intentionally clear future schedules.

## Removed jobs and queues

Removing a schedule stops future scheduled jobs for that scheduler and removes
BullMQ's next programmed delayed job for that scheduler. It does not delete
other queued, active, completed, or failed jobs in the queue.

Removing a job from a deployment also stops creating workers for that job queue.
Existing Redis queue data remains until explicitly drained, cleaned, removed by
job options, or otherwise managed by application operations.

## Logging

The scheduler logs concise lifecycle messages and detailed trace metadata:

- schedule added, updated, unchanged, removed
- scheduled job added, updated, removed
- reconcile summary, including schedule and scheduled-job counts
- warn/error records include enough context to diagnose failed removals or
  startup failures

Debug and info logs are short message-only logs. Trace logs carry structured
metadata.
