import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { StoredWorkflowSchedule, WorkflowScheduler } from '../scheduler.ts'
import type { WorkflowStore } from '../store.ts'
import type { State } from './state.ts'
import { normalizeBatchSize } from '../limits.ts'
import {
  nextStoredScheduleRunAt,
  normalizeScheduleDefinitions,
  startStoredScheduleRun,
} from '../scheduler.ts'

export function createScheduler(
  state: State,
  runtime: {
    readonly store: WorkflowStore
    readonly runCoordinationExecutor: RunCoordinationExecutor
    readonly attemptExecutor: AttemptExecutor
  },
): WorkflowScheduler {
  const { schedules, now, newId } = state

  const requireSchedule = (name: string) => {
    const schedule = schedules.get(name)
    if (!schedule) throw new Error(`Unknown workflow schedule [${name}]`)
    return schedule
  }

  return {
    async reconcile(entries) {
      const at = now()
      const normalized = normalizeScheduleDefinitions(entries, at)
      const names = new Set(normalized.map((entry) => entry.name))

      for (const scheduleName of schedules.keys()) {
        if (!names.has(scheduleName)) schedules.delete(scheduleName)
      }

      for (const entry of normalized) {
        const existing = schedules.get(entry.name)
        // A cadence change, a new schedule or re-enabling an overdue one all
        // restart from the freshly computed slot instead of a stale one.
        const resetNextRunAt =
          existing === undefined ||
          existing.cron !== entry.cron ||
          existing.everyMs !== entry.everyMs ||
          (!existing.enabled && entry.enabled && existing.nextRunAt <= at)

        schedules.set(entry.name, {
          id: existing?.id ?? newId('schedule'),
          ...entry,
          nextRunAt: resetNextRunAt ? entry.nextRunAt : existing.nextRunAt,
          ...(existing?.lastSlotAt === undefined
            ? {}
            : { lastSlotAt: existing.lastSlotAt }),
          createdAt: existing?.createdAt ?? at,
          updatedAt: at,
        })
      }
    },
    async fireDue(options = {}) {
      const at = options.now ?? now()
      const limit = normalizeBatchSize(options.limit)
      if (limit < 1) return { fired: 0 }

      const due = [...schedules.values()]
        .filter((schedule) => schedule.enabled && schedule.nextRunAt <= at)
        .sort(compareByDueDate)
        .slice(0, limit)

      for (const schedule of due) {
        const slot = schedule.nextRunAt
        await startStoredScheduleRun(runtime, schedule, slot)
        schedules.set(schedule.name, {
          ...schedule,
          lastSlotAt: slot,
          nextRunAt: nextStoredScheduleRunAt(schedule, at),
          updatedAt: now(),
        })
      }

      return { fired: due.length }
    },
    async list() {
      return [...schedules.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      )
    },
    async trigger(name) {
      return startStoredScheduleRun(runtime, requireSchedule(name), now())
    },
    async setEnabled(name, enabled) {
      const schedule = requireSchedule(name)
      const at = now()
      const overdue = schedule.nextRunAt <= at
      const updated = {
        ...schedule,
        enabled,
        nextRunAt:
          enabled && !schedule.enabled && overdue
            ? nextStoredScheduleRunAt(schedule, at)
            : schedule.nextRunAt,
        updatedAt: at,
      }
      schedules.set(name, updated)
      return updated
    },
  }
}

function compareByDueDate(
  left: StoredWorkflowSchedule,
  right: StoredWorkflowSchedule,
) {
  const byDate = left.nextRunAt.getTime() - right.nextRunAt.getTime()
  if (byDate !== 0) return byDate
  return left.name.localeCompare(right.name)
}
