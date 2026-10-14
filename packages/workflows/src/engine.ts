import * as Effect from 'effect/Effect'

import type { AttemptCommand, ContinueRun } from './model.ts'
import type { Outcome } from './plan/attempt.ts'
import type { Retention } from './plan/remove.ts'
import type { ScheduleEntry } from './plan/schedule.ts'
import type { StartInput } from './plan/start.ts'
import type { Registry, WorkflowProgram } from './program.ts'
import type { Claim, DeadCommand } from './store.ts'
import { planSettle, settleScope } from './plan/attempt.ts'
import { beginScope, planBegin } from './plan/begin.ts'
import { planCancel } from './plan/cancel.ts'
import { passScope, planPass } from './plan/pass.ts'
import { planReap, planRequeue } from './plan/reap.ts'
import { planDelete, planPrune } from './plan/remove.ts'
import { planRetry } from './plan/retry.ts'
import {
  planFire,
  planReconcile,
  planSetEnabled,
  planTrigger,
} from './plan/schedule.ts'
import { planStart, startScope } from './plan/start.ts'
import { planTimeout, timeoutScope } from './plan/timeout.ts'
import { Store } from './store.ts'

/**
 * Creates a run and queues what starts it, a workflow's first pass or a
 * task's first attempt, or answers with the run a key names.
 */
export const start = (input: StartInput) =>
  Effect.flatMap(Store, (store) =>
    store.transact(startScope(input), planStart(input)),
  )

/** Advances the run a claimed command names as far as stored state allows. */
export const coordinate = (registry: Registry, claim: Claim<ContinueRun>) =>
  Effect.flatMap(Store, (store) =>
    store.transact(
      passScope(registry, claim.command),
      planPass(registry, claim),
    ),
  )

/** Starts the work of the attempt a claimed command names, if it counts. */
export const begin = (registry: Registry, claim: Claim<AttemptCommand>) =>
  Effect.flatMap(Store, (store) =>
    store.transact(beginScope(claim.command), planBegin(registry, claim)),
  )

/** Records the outcome of the attempt a claimed command names. */
export const settle = (
  registry: Registry,
  claim: Claim<AttemptCommand>,
  outcome: Outcome,
) =>
  Effect.flatMap(Store, (store) =>
    store.transact(
      settleScope(claim.command),
      planSettle(registry, claim, outcome),
    ),
  )

/** Asks a run to stop; `undefined` when no such run exists. */
export const cancel = (runId: string) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ runs: [runId] }, planCancel(runId)),
  )

/**
 * Reopens a failed root run in place. It decides from the run alone: whether
 * work of the run's family is still in flight is the caller's to check, as
 * the client's `retry` does.
 */
export const retry = (runId: string, expectedVersion?: number) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ runs: [runId] }, planRetry(runId, expectedVersion)),
  )

/** Ends what a dead command was to continue; `false` when nothing waits. */
export const reap = (dead: DeadCommand) =>
  Effect.flatMap(Store, (store) =>
    store.transact(
      { runs: [dead.command.runId], dead: [dead.id] },
      planReap(dead),
    ),
  )

/** Fails a run of the program that is past its timeout; `false` otherwise. */
export const timeout = (program: WorkflowProgram, runId: string) =>
  Effect.flatMap(Store, (store) =>
    store.transact(timeoutScope(program, runId), planTimeout(program, runId)),
  )

/**
 * Queues the dead command of an id again; `false` when none has it. Decided
 * on the command as it is loaded and guarded: of two callers that found one
 * dead command, only the first queues it.
 */
export const requeue = (id: string) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ dead: [id] }, planRequeue(id)),
  )

/**
 * Makes the stored schedules those given: adds, changes and removes, in one
 * commit. Two entries of one name are refused before anything is asked.
 */
export const reconcile = (entries: readonly ScheduleEntry[]) => {
  const plan = planReconcile(entries)
  return Effect.flatMap(Store, (store) =>
    store.transact({ scheduleNames: true }, plan),
  )
}

/** Fires the slot a schedule is at; `undefined` when nothing of it is due. */
export const fire = (name: string) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ schedules: [name] }, planFire(name)),
  )

/** Starts a run of a schedule now, beside its slots. */
export const trigger = (name: string) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ schedules: [name] }, planTrigger(name)),
  )

export const setScheduleEnabled = (name: string, enabled: boolean) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ schedules: [name] }, planSetEnabled(name, enabled)),
  )

/** Deletes a root run with its family; `false` when no run has the id. */
export const remove = (runId: string) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ families: [runId] }, planDelete(runId)),
  )

/** Removes a root's family when retention still lets it go; `false` if not. */
export const prune = (runId: string, retention: Retention) =>
  Effect.flatMap(Store, (store) =>
    store.transact({ families: [runId] }, planPrune(runId, retention)),
  )
