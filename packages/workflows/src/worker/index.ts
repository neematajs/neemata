import * as Effect from 'effect/Effect'

import type { AnyTask } from '../dsl/task.ts'
import type { ServedWorkflow } from '../dsl/workflow.ts'
import type {
  CleanupTimeout,
  DefinitionConflict,
  StorageError,
} from '../errors.ts'
import type { ContinueRun } from '../model.ts'
import type { Registry } from '../program.ts'
import type { Claim } from '../store.ts'
import type { MaintenanceOptions } from './maintenance.ts'
import type { PoolOptions } from './pool.ts'
import type { PoolServices, Served } from './serve.ts'
import { coordinate, drain } from '../engine.ts'
import { Store } from '../store.ts'
import { runAttempt } from './attempt.ts'
import { jobs, periodically, reconcileSchedules } from './maintenance.ts'
import { backoffMs, pool, resolve, surviving } from './pool.ts'
import { serving } from './serve.ts'

export type Options = PoolOptions & {
  /** The code this worker has: it takes work of these routes only. */
  readonly registry: Registry
}

export type ExecutionOptions = {
  /**
   * How long a handler that was interrupted may take to end, finalizers
   * included, before the worker gives up on it and fails with
   * `CleanupTimeout`. 5 seconds when omitted.
   */
  readonly cleanupTimeoutMs?: number
}

/**
 * Advances the runs of the workflows it is given, until interrupted, and
 * runs the maintenance of the engine beside it. A pass writes all or
 * nothing, so it is never interrupted: stopping waits for the passes under
 * way.
 *
 * A storage failure of a pass or of a maintenance job is logged and the work
 * is tried again later. It fails with `StorageError` only when the store
 * fails it before it holds anything: reconciling its schedules as it starts,
 * or claiming. It fails with `DefinitionConflict` when a declared schedule's
 * runnable is not what is saved for its revision.
 */
export const coordinator = (
  options: MaintenanceOptions &
    (Options | (PoolOptions & Pick<Served, 'workflows'>)),
): Effect.Effect<never, DefinitionConflict | StorageError, Store> => {
  const registry =
    'registry' in options
      ? options.registry
      : serving({ workflows: options.workflows })
  const maintenance = jobs(registry, options)
  // Before any slot is fired: a fire pins its run to what is reconciled.
  const reconciled = options.schedules
    ? Effect.catchTag(
        reconcileSchedules(options.schedules),
        'StaleClaim',
        Effect.die,
      )
    : Effect.void

  const pass = (claim: Claim<ContinueRun>) =>
    Effect.gen(function* () {
      const result = yield* coordinate(registry, claim)
      if (result._tag === 'Advanced') {
        // The pass gave up its claim, so a drain may find nothing of the run
        // claimed. One that fails is the sweep's to do again.
        if (result.draining) {
          yield* drain(result.draining).pipe(
            Effect.catchTag('StorageError', (error) =>
              Effect.logWarning('Workflow cancellation drain failed', error),
            ),
          )
        }
        return
      }
      if (result._tag !== 'Unroutable') return
      const { name, revision, runId } = claim.command
      const store = yield* Store
      yield* store.release(claim, {
        error:
          result.error ??
          new Error(
            `No registered workflow advances run [${runId}] of [${name}${revision === undefined ? '' : `@${revision}`}]`,
          ),
        delayMs: backoffMs(claim),
      })
    }).pipe(
      // A claim that is no longer held is another delivery's to work.
      Effect.catchTag('StaleClaim', () => Effect.void),
      surviving(claim),
    )

  const passes = pool(
    [{ kind: 'continueRun', routes: registry.workflows }],
    resolve(options),
    pass,
  )
  return Effect.scoped(
    reconciled.pipe(
      Effect.andThen(
        Effect.forEach(
          maintenance,
          (job) => Effect.forkScoped(periodically(job)),
          { discard: true },
        ),
      ),
      Effect.andThen(passes),
    ),
  )
}

/**
 * Runs the attempts it has handlers for, activities and tasks, until
 * interrupted. Interruption interrupts the handlers, gives their commands
 * back for another worker, and is over when that is done.
 *
 * Given declarations, it runs those of `pool`, or all of them without one,
 * and requires what their handlers do. Given a registry, whose programs do
 * not say, `R` states what the handlers require.
 *
 * It fails with `CleanupTimeout` when a handler it interrupted does not end
 * in time: such a handler can only be left behind, so the process is to be
 * replaced. It fails with `StorageError` when the store fails a claim, once
 * the handlers it has are done; any other storage failure it outlives.
 */
export function execution<R = never>(
  options: Options & ExecutionOptions,
): Effect.Effect<never, CleanupTimeout | StorageError, Store | R>
export function execution<
  W extends ServedWorkflow = never,
  T extends AnyTask = never,
  Pool extends string = string,
>(
  options: PoolOptions &
    ExecutionOptions &
    Served<W, T> & {
      /** The pool this worker is of; it serves every pool when omitted. */
      readonly pool?: Pool
    },
): Effect.Effect<
  never,
  CleanupTimeout | StorageError,
  Store | PoolServices<W | T, Pool>
>
export function execution(
  options: ExecutionOptions &
    (Options | (PoolOptions & Served & { readonly pool?: string })),
): Effect.Effect<never, CleanupTimeout | StorageError, unknown> {
  const registry =
    'registry' in options ? options.registry : serving(options, options.pool)
  const resolved = resolve(options)
  const { cleanupTimeoutMs = 5_000 } = options
  if (!Number.isFinite(cleanupTimeoutMs) || cleanupTimeoutMs < 0) {
    throw new Error(
      'Worker cleanupTimeoutMs must be a finite non-negative number',
    )
  }

  return pool(
    [
      { kind: 'runAttempt', routes: registry.workflows },
      { kind: 'runTask', routes: registry.tasks },
    ],
    resolved,
    runAttempt(registry, { leaseMs: resolved.leaseMs, cleanupTimeoutMs }),
  )
}

export {
  drainCancellations,
  fireSchedules,
  pruneRuns,
  reapDeadCommands,
  reconcileSchedules,
  timeoutRuns,
} from './maintenance.ts'
export type {
  MaintenanceOptions,
  PruneParams,
  SweepOptions,
} from './maintenance.ts'
export { verify } from './serve.ts'
export type { PoolServices, Served } from './serve.ts'
