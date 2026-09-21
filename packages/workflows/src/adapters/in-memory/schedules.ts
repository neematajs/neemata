import type { WorkflowRuntimeAdapter } from '../../runtime/client.ts'
import type {
  StoredWorkflowSchedule,
  WorkflowScheduler,
} from '../../runtime/scheduler.ts'
import type { State } from './state.ts'
import {
  nextStoredScheduleRunAt,
  normalizeScheduleDefinitions,
  startStoredScheduleRun,
} from '../../runtime/scheduler.ts'

function normalizeScheduleLimit(limit: number | undefined) {
  if (limit === undefined) return 100
  if (!Number.isInteger(limit) || limit < 1) return 0
  return limit
}

function compareSchedulesByDueDate(
  left: StoredWorkflowSchedule,
  right: StoredWorkflowSchedule,
) {
  const byDate = left.nextRunAt - right.nextRunAt
  if (byDate !== 0) return byDate
  return left.name.localeCompare(right.name)
}

export function createScheduler(
  state: State,
  runtime: Pick<
    WorkflowRuntimeAdapter,
    'store' | 'runCoordinationExecutor' | 'attemptExecutor'
  >,
): WorkflowScheduler {
  const { store, runCoordinationExecutor, attemptExecutor } = runtime
  const { id, now, schedules } = state

  return {
    async reconcile(entries) {
      const date = now()
      const normalizedEntries = normalizeScheduleDefinitions(entries, date)
      const names = new Set(normalizedEntries.map((entry) => entry.name))
      for (const scheduleName of schedules.keys()) {
        if (!names.has(scheduleName)) schedules.delete(scheduleName)
      }

      for (const normalized of normalizedEntries) {
        const existing = schedules.get(normalized.name)
        const shouldResetNextRunAt =
          existing === undefined ||
          existing.cron !== normalized.cron ||
          existing.everyMs !== normalized.everyMs ||
          (!existing.enabled &&
            normalized.enabled &&
            existing.nextRunAt <= date)
        schedules.set(normalized.name, {
          id: existing?.id ?? id('schedule'),
          name: normalized.name,
          runnableKind: normalized.runnableKind,
          runnableName: normalized.runnableName,
          input: normalized.input,
          tags: normalized.tags,
          ...(normalized.cron === undefined ? {} : { cron: normalized.cron }),
          ...(normalized.everyMs === undefined
            ? {}
            : { everyMs: normalized.everyMs }),
          enabled: normalized.enabled,
          nextRunAt: shouldResetNextRunAt
            ? normalized.nextRunAt
            : existing.nextRunAt,
          ...(existing?.lastSlotAt === undefined
            ? {}
            : { lastSlotAt: existing.lastSlotAt }),
          createdAt: existing?.createdAt ?? date,
          updatedAt: date,
        })
      }
    },
    async fireDue(options = {}) {
      const date = options.now ?? now()
      const limit = normalizeScheduleLimit(options.limit)
      if (limit < 1) return { fired: 0 }
      const due = [...schedules.values()]
        .filter((schedule) => schedule.enabled && schedule.nextRunAt <= date)
        .sort(compareSchedulesByDueDate)
        .slice(0, limit)

      for (const schedule of due) {
        const slot = schedule.nextRunAt
        await startStoredScheduleRun(
          { store, runCoordinationExecutor, attemptExecutor },
          schedule,
          slot,
        )
        const updated: StoredWorkflowSchedule = {
          ...schedule,
          lastSlotAt: slot,
          nextRunAt: nextStoredScheduleRunAt(schedule, date),
          updatedAt: now(),
        }
        schedules.set(schedule.name, updated)
      }

      return { fired: due.length }
    },
    async list() {
      return [...schedules.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      )
    },
    async trigger(name) {
      const schedule = schedules.get(name)
      if (!schedule) throw new Error(`Unknown workflow schedule [${name}]`)
      return startStoredScheduleRun(
        { store, runCoordinationExecutor, attemptExecutor },
        schedule,
        now(),
      )
    },
    async setEnabled(name, enabled) {
      const schedule = schedules.get(name)
      if (!schedule) throw new Error(`Unknown workflow schedule [${name}]`)
      const date = now()
      const updated = {
        ...schedule,
        enabled,
        nextRunAt:
          enabled && !schedule.enabled && schedule.nextRunAt <= date
            ? nextStoredScheduleRunAt(schedule, date)
            : schedule.nextRunAt,
        updatedAt: date,
      }
      schedules.set(name, updated)
      return updated
    },
  }
}
