import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'

import type { AnySchedule } from '../dsl/schedule.ts'
import type {
  DurationString,
  RunStatus,
  TerminalStatus,
  Timestamp,
} from '../model.ts'
import type { Registry } from '../program.ts'
import { scheduleEntry } from '../dsl/schedule.ts'
import * as Engine from '../engine.ts'
import { parseDurationMs, STATUSES } from '../model.ts'
import { Store } from '../store.ts'

export type SweepOptions = {
  /** How often the sweep runs. */
  readonly everyMs?: number
  /** How many candidates one read of the sweep takes. 100 when omitted. */
  readonly batchSize?: number
}

export type MaintenanceOptions = {
  /**
   * Fails what the dead commands were to continue, and ends the
   * cancellations of runs nothing of which is claimed any more, so that no
   * run waits forever for work nobody is given. Every 30 seconds unless
   * `false`.
   */
  readonly reaping?: false | SweepOptions
  /**
   * Fails the runs of the worker's workflows that are past their `timeout`.
   * Every 60 seconds unless `false`.
   */
  readonly runTimeouts?: false | SweepOptions
  /**
   * The schedules of the deployment, all of them. Given, the worker makes
   * the stored schedules these as it starts, and removes any other; then it
   * fires those that are due. Omitted, it leaves schedules alone.
   */
  readonly schedules?: readonly AnySchedule[]
  /** How the due schedules are fired: every second unless it says. */
  readonly scheduling?: SweepOptions
  /**
   * Removes the families of root runs that ended longer ago than
   * `olderThan`, every 60 seconds. Nothing is removed when omitted.
   */
  readonly retention?: SweepOptions & {
    readonly olderThan: DurationString
    /** Every status a run ends in when omitted. */
    readonly statuses?: readonly TerminalStatus[]
  }
}

// A run `cancelling` is not timed out: it ends `cancelled`, as it was asked
// to, once the child runs it cancelled have ended. A `blocked` one is: its
// deadline does not wait for an operator.
const OVERDUE: readonly RunStatus[] = [
  'queued',
  'running',
  'waiting',
  'blocked',
]

function batch({ batchSize = 100 }: SweepOptions) {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('Sweep batchSize must be a positive integer')
  }
  return batchSize
}

/**
 * One sweep over the dead commands of runs that have not ended, each settled
 * in a commit of its own that decides again whether anything waits for it.
 * Answers how many it ended something for.
 */
export const reapDeadCommands = Effect.fnUntraced(function* (
  options: Pick<SweepOptions, 'batchSize'> = {},
) {
  const store = yield* Store
  const limit = batch(options)
  let reaped = 0
  let after: string | undefined
  do {
    const page = yield* store.dead({
      active: true,
      limit,
      ...(after === undefined ? {} : { after }),
    })
    for (const dead of page.items) {
      if (yield* Engine.reap(dead)) reaped += 1
    }
    after = page.next
  } while (after !== undefined)
  return { reaped }
})

/**
 * One sweep over the runs being cancelled, each drained when nothing of it
 * is claimed: a cancellation waits for handlers to stop, and one whose
 * worker died, or whose work no worker serves, has nobody else to end it.
 * Answers how many it drained.
 */
export const drainCancellations = Effect.fnUntraced(function* (
  options: Pick<SweepOptions, 'batchSize'> = {},
) {
  const store = yield* Store
  const limit = batch(options)
  let drained = 0
  let after: string | undefined
  do {
    const page = yield* store.runs({
      filter: { status: ['cancelling'] },
      limit,
      ...(after === undefined ? {} : { after }),
    })
    // Seen `cancelling` before their claims are read, as a drain's are.
    const left = yield* Engine.drain(page.items)
    drained += left.filter(({ status }) => status !== 'cancelling').length
    after = page.next
  } while (after !== undefined)
  return { drained }
})

/**
 * One sweep over the active runs of the registry's workflows that are past
 * their timeout, each failed in a commit of its own that checks it again. A
 * run of a workflow or revision the registry does not hold is never found:
 * only its own code says how long it may take.
 */
export const timeoutRuns = Effect.fnUntraced(function* (
  registry: Registry,
  options: Pick<SweepOptions, 'batchSize'> = {},
) {
  const store = yield* Store
  const limit = batch(options)
  let timedOut = 0
  for (const route of registry.workflows) {
    const program = registry.workflow(route)!
    const timeoutMs = parseDurationMs(program.timeout)
    if (timeoutMs === undefined) continue

    const now = yield* Clock.currentTimeMillis
    let after: string | undefined
    do {
      const page = yield* store.runs({
        filter: {
          kind: 'workflow',
          name: program.name,
          revision: program.revision ?? null,
          status: OVERDUE,
          activeBefore: now - timeoutMs,
        },
        limit,
        ...(after === undefined ? {} : { after }),
      })
      for (const { id } of page.items) {
        if (yield* Engine.timeout(program, id)) timedOut += 1
      }
      after = page.next
    } while (after !== undefined)
  }
  return { timedOut }
})

/**
 * Makes the stored schedules those declared. An input that does not encode
 * and two schedules of one name are refused before anything is asked.
 */
export const reconcileSchedules = (schedules: readonly AnySchedule[]) =>
  Engine.reconcile(schedules.map(scheduleEntry))

/**
 * One sweep over the schedules that are due, each fired in a commit of its
 * own that checks it again: a slot another scheduler fired first is found
 * moved on. Answers how many slots it fired.
 */
export const fireSchedules = Effect.fnUntraced(function* (
  options: Pick<SweepOptions, 'batchSize'> = {},
) {
  const store = yield* Store
  const limit = batch(options)
  const due = yield* Clock.currentTimeMillis
  let fired = 0
  let after: string | undefined
  do {
    const page = yield* store.schedules({
      due,
      limit,
      ...(after === undefined ? {} : { after }),
    })
    for (const { name } of page.items) {
      if (yield* Engine.fire(name)) fired += 1
    }
    after = page.next
  } while (after !== undefined)
  return { fired }
})

export type PruneParams = {
  /** Roots last written before this are old enough to go. */
  readonly olderThan: Timestamp
  /** Every status a run ends in when omitted. */
  readonly statuses?: readonly TerminalStatus[]
  /** How many roots one read of the sweep takes. 100 when omitted. */
  readonly batchSize?: number
}

/** Refused before anything is read, so a wrong setting deletes nothing. */
export function pruneBatch(batchSize = 100) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 0) {
    throw new RangeError(
      'Retention batchSize must be a non-negative safe integer',
    )
  }
  return batchSize
}

/**
 * One sweep over the root runs that ended in one of `statuses` and were not
 * written since `olderThan`. Each family is removed whole, in a commit of
 * its own that looks at it again: one with anything still in flight stays,
 * and is passed over until a later sweep. Answers how many roots went.
 */
export const pruneRuns = (params: PruneParams) => {
  const limit = pruneBatch(params.batchSize)
  const { olderThan: updatedBefore } = params
  const statuses = params.statuses ?? STATUSES.terminal

  return Effect.gen(function* () {
    const store = yield* Store
    let deleted = 0
    // A batch of none reads nothing: there is no page to go on from.
    for (const status of limit > 0 ? statuses : []) {
      let after: string | undefined
      do {
        const page = yield* store.prunable({
          status,
          updatedBefore,
          limit,
          ...(after === undefined ? {} : { after }),
        })
        for (const runId of page.items) {
          if (yield* Engine.prune(runId, { statuses, updatedBefore })) {
            deleted += 1
          }
        }
        after = page.next
      } while (after !== undefined)
    }
    return { deleted }
  })
}

/** A job a worker runs beside its commands, for as long as it serves. */
type Job = {
  readonly name: string
  readonly everyMs: number
  readonly run: Effect.Effect<unknown, unknown, Store>
}

function every(name: string, { everyMs }: SweepOptions, fallback: number) {
  const ms = everyMs ?? fallback
  if (!(ms > 0)) throw new Error(`Worker ${name} everyMs must be positive`)
  return ms
}

/** The jobs of a coordinator, as its options turn them on. */
export function jobs(
  registry: Registry,
  options: MaintenanceOptions,
): readonly Job[] {
  const { reaping = {}, runTimeouts = {}, scheduling = {}, retention } = options
  const enabled: Job[] = []
  if (reaping) {
    batch(reaping)
    enabled.push({
      name: 'reaping',
      everyMs: every('reaping', reaping, 30_000),
      run: Effect.andThen(
        reapDeadCommands(reaping),
        drainCancellations(reaping),
      ),
    })
  }
  if (runTimeouts) {
    batch(runTimeouts)
    enabled.push({
      name: 'runTimeouts',
      everyMs: every('runTimeouts', runTimeouts, 60_000),
      run: timeoutRuns(registry, runTimeouts),
    })
  }
  if (options.schedules) {
    batch(scheduling)
    enabled.push({
      name: 'scheduling',
      everyMs: every('scheduling', scheduling, 1_000),
      run: fireSchedules(scheduling),
    })
  }
  if (retention) {
    const { olderThan, statuses, batchSize } = retention
    pruneBatch(batchSize)
    const olderThanMs = parseDurationMs(olderThan)
    if (olderThanMs === undefined) {
      throw new Error(`Invalid retention olderThan duration [${olderThan}]`)
    }
    enabled.push({
      name: 'retention',
      everyMs: every('retention', retention, 60_000),
      run: Effect.flatMap(Clock.currentTimeMillis, (now) =>
        pruneRuns({
          olderThan: now - olderThanMs,
          ...(statuses === undefined ? {} : { statuses }),
          ...(batchSize === undefined ? {} : { batchSize }),
        }),
      ),
    })
  }
  return enabled
}

/**
 * Runs a job again and again until interrupted. A run that fails is logged
 * and tried again at its next turn: everything a job does is decided in
 * commits of its own, so a sweep cut short loses nothing.
 */
export const periodically = ({ name, everyMs, run }: Job) =>
  Effect.forever(
    Effect.sleep(everyMs).pipe(
      Effect.andThen(run),
      Effect.catchCause((cause) =>
        Effect.logError(`Workflow maintenance [${name}] failed`, cause),
      ),
    ),
  )
