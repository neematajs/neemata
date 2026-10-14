import type { DurationString } from '../model.ts'
import type { ScheduleEntry } from '../plan/schedule.ts'
import type { InputOf } from './declaration.ts'
import type { AnyTask } from './task.ts'
import type { ServedWorkflow } from './workflow.ts'
import { parseDurationMs } from '../model.ts'
import { parseCron } from '../plan/schedule.ts'

type Runnable = AnyTask | ServedWorkflow

export type ScheduleOptions<Name extends string, R extends Runnable> = {
  readonly name: Name
  /** The task or workflow each slot starts a run of. */
  readonly runnable: R
  readonly input: InputOf<R>
  /** Exactly one of `cron` and `every` says when the schedule fires. */
  readonly cron?: string
  /**
   * The zone `cron` is read in, as IANA names it. The zone of the process
   * that declares the schedule when omitted; it is stored either way, so
   * every scheduler reads the expression alike.
   */
  readonly timeZone?: string
  readonly every?: DurationString
  /** Replace the tags the runnable builds from the input. */
  readonly tags?: Readonly<Record<string, string>>
  /** True when omitted. A schedule that is not enabled never fires. */
  readonly enabled?: boolean
  /** Makes the first slot the moment the schedule is first reconciled. */
  readonly immediately?: boolean
}

/** A schedule declared once, for the workers that reconcile it. */
export type Schedule<
  Name extends string = string,
  R extends Runnable = Runnable,
> = ScheduleOptions<Name, R> & {
  readonly kind: 'schedule'
  readonly enabled: boolean
}

export type AnySchedule = Schedule<string, any>

function assertCadence({
  name,
  cron,
  timeZone,
  every,
}: ScheduleOptions<string, Runnable>) {
  if ((cron === undefined) === (every === undefined)) {
    throw new Error(`Schedule [${name}] must define exactly one of cron/every`)
  }
  if (every !== undefined) {
    const everyMs = parseDurationMs(every)
    if (everyMs === undefined || everyMs <= 0) {
      throw new Error(`Invalid schedule [${name}] every duration [${every}]`)
    }
    // An interval is stored, and slots are counted, in whole milliseconds.
    if (!Number.isSafeInteger(everyMs)) {
      throw new Error(
        `Schedule [${name}] every duration [${every}] is not a whole number of milliseconds`,
      )
    }
    if (timeZone !== undefined) {
      throw new Error(`Schedule [${name}] timeZone applies to cron only`)
    }
    return
  }

  if (timeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone })
    } catch (error) {
      throw new Error(`Invalid schedule [${name}] timeZone [${timeZone}]`, {
        cause: error,
      })
    }
  }
  try {
    parseCron(cron!, name, timeZone)
  } catch (error) {
    throw new Error(`Invalid schedule [${name}] cron [${cron!}]`, {
      cause: error,
    })
  }
}

/**
 * Declares that runs of a task or workflow start by themselves: at the times
 * a cron expression names, or every so often.
 */
export function schedule<const Name extends string, R extends Runnable>(
  options: ScheduleOptions<Name, R>,
): Schedule<Name, R> {
  assertCadence(options)
  return Object.freeze({
    ...options,
    kind: 'schedule',
    enabled: options.enabled ?? true,
  })
}

/**
 * A declared schedule as a reconcile takes it: its input as it is stored,
 * and the description its runs are pinned to.
 */
export function scheduleEntry(declared: AnySchedule): ScheduleEntry {
  const { name, runnable, input, cron, every, enabled, immediately } = declared
  let stored: unknown
  try {
    stored = runnable.input.encode(input)
  } catch (error) {
    throw new Error(`Invalid schedule [${name}] input`, { cause: error })
  }
  const { kind, revision, program } = runnable as Runnable
  const timeZone =
    declared.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone

  return {
    name,
    runnable: {
      kind,
      name: runnable.name,
      ...(revision === undefined ? {} : { revision }),
    },
    ...(program.definition === undefined
      ? {}
      : { definition: program.definition }),
    input: stored,
    tags: declared.tags ?? runnable.tags?.(input) ?? {},
    ...(cron === undefined
      ? { everyMs: parseDurationMs(every)! }
      : { cron, timeZone }),
    enabled,
    ...(immediately ? { immediately } : {}),
  }
}
