import { CronExpressionParser } from 'cron-parser'

import type { DefinitionConflict, Runnable } from '../errors.ts'
import type { StoredRun, StoredSchedule, Timestamp } from '../model.ts'
import type { Described } from '../program.ts'
import type { Plan } from '../store.ts'
import type { Draft } from './draft.ts'
import { UnknownSchedule } from '../errors.ts'
import { conflicting, save } from './definitions.ts'
import { planning, Refused } from './draft.ts'
import { canonical, idempotencyKey } from './keys.ts'
import { createRoot } from './start.ts'

/** When a schedule fires: by a cron expression, or at a fixed interval. */
export type Cadence = Pick<StoredSchedule, 'cron' | 'timeZone' | 'everyMs'>

/** A schedule as declared, with stored values: what a reconcile is given. */
export type ScheduleEntry = Cadence &
  Pick<StoredSchedule, 'name' | 'input' | 'tags' | 'enabled'> & {
    readonly runnable: Runnable
    /**
     * The description of the program the schedule starts runs of. Its records
     * are saved with the schedule, so no fire lacks what its run is pinned to.
     */
    readonly definition?: Described
    /** Makes the first slot the moment the schedule is first reconciled. */
    readonly immediately?: boolean
  }

/**
 * A cron expression as the engine reads it, or what is wrong with it.
 *
 * `seed` is the schedule's name. It is what an `H` in the expression is
 * hashed from: without one the parser would pick the hashed slot at random
 * each time it is asked, and a plan that runs twice would name two slots.
 */
export function parseCron(
  cron: string,
  seed: string,
  timeZone?: string,
  from?: Timestamp,
) {
  return CronExpressionParser.parse(cron, {
    currentDate: new Date(from ?? 0),
    hashSeed: seed,
    ...(timeZone === undefined ? {} : { tz: timeZone }),
  })
}

/**
 * The first slot after `now`. An interval counts from `base`, the slot the
 * schedule was at, so its slots keep their phase however late one fires;
 * the slots between `base` and `now` were missed and are not made up for.
 */
function slotAfter(
  schedule: Cadence & Pick<StoredSchedule, 'name'>,
  now: Timestamp,
  base: Timestamp,
) {
  const { name, cron, timeZone, everyMs } = schedule
  if (cron !== undefined) {
    return parseCron(cron, name, timeZone, now).next().getTime()
  }
  if (everyMs === undefined || !(everyMs > 0)) {
    throw new Error('Schedule everyMs must be a positive number')
  }
  const missed = Math.max(0, Math.floor((now - base) / everyMs))
  return base + (missed + 1) * everyMs
}

/**
 * The key of a slot's run. Schedulers derive it and nobody else does, so a
 * run that holds it is that slot's run, whoever created it.
 */
const slotKey = (name: string, slot: Timestamp) =>
  ['$schedule', name, slot] as const

function startRun(
  draft: Draft,
  schedule: StoredSchedule,
  idempotencyKey?: readonly unknown[],
): StoredRun {
  const { name, runnable, graphHash, presentation, input, tags } = schedule
  return createRoot(draft, {
    ...runnable,
    ...(graphHash === undefined ? {} : { graphHash }),
    ...(presentation === undefined ? {} : { presentation }),
    input,
    tags: { ...tags, schedule: name },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  })
}

/**
 * Makes the stored schedules those declared, in one commit: every scheduler
 * sees the old set or the new one, never a mix of two reconciles.
 *
 * A schedule keeps the slot it was at unless its cadence changed, or it is
 * enabled again after its slot passed: what a reconcile changes applies to
 * the slots still to come, and none is fired twice because a process
 * restarted. A schedule that is no longer declared is removed.
 */
export function planReconcile(
  entries: readonly ScheduleEntry[],
): Plan<readonly StoredSchedule[], DefinitionConflict> {
  const declared = new Set<string>()
  for (const { name, everyMs } of entries) {
    if (declared.has(name)) {
      throw new Error(`Duplicate workflow schedule [${name}]`)
    }
    declared.add(name)
    // Refused here, for every store alike: one of them keeps an interval as
    // a whole number, and would fail the commit for any other.
    if (
      everyMs !== undefined &&
      !(Number.isSafeInteger(everyMs) && everyMs > 0)
    ) {
      throw new Error(
        `Schedule [${name}] everyMs [${everyMs}] must be a positive whole number of milliseconds`,
      )
    }
  }
  const keys = entries.flatMap(({ definition }) =>
    (definition?.records ?? []).map(({ key }) => key),
  )

  return planning<readonly StoredSchedule[], DefinitionConflict>((draft) => {
    const stored = draft.scheduleNames()
    draft.require({ schedules: [...stored, ...declared], definitions: keys })
    // Each entry against what is saved and what the entries before it bring,
    // so no two disagree about one revision. A conflict refuses the whole
    // reconcile: the schedules stay as they were.
    for (const { definition } of entries) {
      const records = definition?.records ?? []
      const conflict = conflicting(draft, records)
      if (conflict) return new Refused(conflict)
      save(draft, records)
    }

    for (const name of stored) {
      if (!declared.has(name)) draft.removeSchedule(name)
    }
    return entries.map((entry) => {
      const { definition, immediately, runnable, ...declaration } = entry
      const { cron, timeZone, everyMs, enabled } = entry
      const existing = draft.schedule(entry.name)
      const moved =
        !existing ||
        existing.cron !== cron ||
        existing.timeZone !== timeZone ||
        existing.everyMs !== everyMs ||
        (!existing.enabled && enabled && existing.nextRunAt <= draft.now)
      const { name: target, kind, revision } = runnable
      const fields = {
        ...declaration,
        runnable: {
          kind,
          name: target,
          ...(revision === undefined ? {} : { revision }),
        },
        ...(definition === undefined
          ? {}
          : {
              graphHash: definition.graphHash,
              ...(definition.presentation === undefined
                ? {}
                : { presentation: definition.presentation }),
            }),
        nextRunAt: !moved
          ? existing.nextRunAt
          : immediately
            ? draft.now
            : slotAfter(entry, draft.now, draft.now),
        ...(existing?.lastSlotAt === undefined
          ? {}
          : { lastSlotAt: existing.lastSlotAt }),
      }
      if (!existing) return draft.createSchedule(fields)

      const { version, createdAt, updatedAt } = existing
      const next = { ...fields, version, createdAt, updatedAt }
      // Every worker reconciles as it starts: a declaration that says what
      // is stored writes nothing, and so contends with no fire.
      return canonical(next) === canonical(existing)
        ? existing
        : draft.updateSchedule(next, {})
    })
  })
}

export type Fired = {
  readonly run: StoredRun
  /** False when the slot's run existed already and was adopted. */
  readonly created: boolean
}

/**
 * Fires the slot a schedule is at, when that slot is due: starts its run and
 * moves the schedule past now in the same commit, so the slot is fired once
 * however many schedulers find it. Slots missed meanwhile are skipped.
 *
 * A run that holds the slot's key already is the slot's run: one a scheduler
 * of the engine before this one created without recording the slot. It is
 * adopted, whatever the schedule has become since, and nothing is started.
 *
 * `undefined` when the schedule has nothing due: it is disabled or gone, or
 * another scheduler fired the slot.
 */
export function planFire(name: string): Plan<Fired | undefined> {
  return planning<Fired | undefined>((draft) => {
    const schedule = draft.schedule(name)
    if (!schedule?.enabled || schedule.nextRunAt > draft.now) return undefined

    const slot = schedule.nextRunAt
    const key = slotKey(name, slot)
    const holderId = draft.holder(idempotencyKey(key))
    const adopted = holderId === undefined ? undefined : draft.head(holderId)
    const run = adopted ?? startRun(draft, schedule, key)
    draft.updateSchedule(schedule, {
      lastSlotAt: slot,
      nextRunAt: slotAfter(schedule, draft.now, slot),
    })
    return { run, created: !adopted }
  })
}

/**
 * Starts a run of a schedule now, whether or not it is enabled. A run of its
 * own, beside the slots: it holds no key, as nothing is to answer for it
 * twice, and the schedule itself is left as it is.
 */
export function planTrigger(name: string): Plan<StoredRun, UnknownSchedule> {
  return planning<StoredRun, UnknownSchedule>((draft) => {
    const schedule = draft.schedule(name)
    if (!schedule) return new Refused(new UnknownSchedule({ name }))
    return startRun(draft, schedule)
  })
}

/**
 * Turns a schedule on or off. Turned on after its slot passed, it starts
 * from the next one: what it missed while off is not fired.
 */
export function planSetEnabled(
  name: string,
  enabled: boolean,
): Plan<StoredSchedule, UnknownSchedule> {
  return planning<StoredSchedule, UnknownSchedule>((draft) => {
    const schedule = draft.schedule(name)
    if (!schedule) return new Refused(new UnknownSchedule({ name }))
    const resumed =
      enabled && !schedule.enabled && schedule.nextRunAt <= draft.now
    return draft.updateSchedule(schedule, {
      enabled,
      ...(resumed
        ? { nextRunAt: slotAfter(schedule, draft.now, schedule.nextRunAt) }
        : {}),
    })
  })
}
