import { CronExpressionParser } from 'cron-parser'

import type {
  AnyScheduleDefinition,
  RunKind,
  RunTags,
  ScheduleDefinition,
} from '../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type { StoredRun } from './state.ts'
import type { WorkflowStore } from './store.ts'
import { continueRun } from './commands.ts'
import { dispatchTaskRunAttempt } from './coordinator/attempt.ts'
import { decodeSchemaValue, resolveTags } from './coordinator/codec.ts'
import { parseDurationMs } from './duration.ts'

export type StoredWorkflowSchedule = {
  readonly id: string
  readonly name: string
  readonly runnableKind: RunKind
  readonly runnableName: string
  readonly input: unknown
  readonly tags: RunTags
  readonly cron?: string
  readonly everyMs?: number
  readonly enabled: boolean
  readonly nextRunAt: Date
  readonly lastSlotAt?: Date
  readonly createdAt: Date
  readonly updatedAt: Date
}

export type WorkflowSchedulerFireDueOptions = {
  readonly now?: Date
  readonly limit?: number
}

export type WorkflowSchedulerFireDueResult = {
  readonly fired: number
}

export type WorkflowScheduler = {
  reconcile(entries: readonly AnyScheduleDefinition[]): Promise<void>
  fireDue(
    options?: WorkflowSchedulerFireDueOptions,
  ): Promise<WorkflowSchedulerFireDueResult>
  list(): Promise<readonly StoredWorkflowSchedule[]>
  trigger(name: string): Promise<StoredRun>
  setEnabled(name: string, enabled: boolean): Promise<StoredWorkflowSchedule>
}

export type ScheduleCadence = Pick<StoredWorkflowSchedule, 'cron' | 'everyMs'>

export type NormalizedScheduleEntry = Omit<
  StoredWorkflowSchedule,
  'id' | 'lastSlotAt' | 'createdAt' | 'updatedAt'
>

export function normalizeScheduleDefinitions(
  definitions: readonly AnyScheduleDefinition[],
  now: Date,
): readonly NormalizedScheduleEntry[] {
  const names = new Set<string>()
  return definitions.map((definition) => {
    if (names.has(definition.name)) {
      throw new Error(`Duplicate workflow schedule [${definition.name}]`)
    }
    names.add(definition.name)
    return normalizeScheduleDefinition(definition, now)
  })
}

function normalizeScheduleDefinition(
  definition: AnyScheduleDefinition,
  now: Date,
): NormalizedScheduleEntry {
  const cadence = parseScheduleCadence(definition)
  const { kind: runnableKind, name: runnableName } = definition.runnable
  const input = decodeScheduleInput(definition)
  const tags =
    definition.tags ?? resolveTags(definition.runnable.tags, input) ?? {}
  const nextRunAt =
    definition.immediately === true ? now : nextScheduleRunAt(cadence, now, now)

  return {
    name: definition.name,
    runnableKind,
    runnableName,
    input,
    tags,
    ...cadence,
    enabled: definition.enabled ?? true,
    nextRunAt,
  }
}

export function nextStoredScheduleRunAt(
  schedule: Pick<StoredWorkflowSchedule, 'cron' | 'everyMs' | 'nextRunAt'>,
  now: Date,
): Date {
  return nextScheduleRunAt(schedule, now, schedule.nextRunAt)
}

export async function startStoredScheduleRun(
  runtime: {
    readonly store: WorkflowStore
    readonly runCoordinationExecutor: RunCoordinationExecutor
    readonly attemptExecutor: AttemptExecutor
  },
  schedule: StoredWorkflowSchedule,
  slot: Date,
): Promise<StoredRun> {
  const idempotencyKey = ['$schedule', schedule.name, slot.toISOString()]
  const tags = { ...schedule.tags, schedule: schedule.name }
  const run = await runtime.store.createRun({
    kind: schedule.runnableKind,
    name: schedule.runnableName,
    workflowName: schedule.runnableName,
    ...(schedule.runnableKind === 'task'
      ? { taskName: schedule.runnableName }
      : {}),
    input: schedule.input,
    tags,
    idempotencyKey,
  })

  if (schedule.runnableKind === 'task') {
    await dispatchTaskRunAttempt(runtime, {
      taskName: schedule.runnableName,
      taskRunId: run.id,
      taskInput: schedule.input,
      idempotencyKey,
      failRunOnDispatchFailure: true,
    })
    return run
  }

  await runtime.runCoordinationExecutor.enqueue(continueRun(run))
  return run
}

function decodeScheduleInput(definition: ScheduleDefinition): unknown {
  try {
    return decodeSchemaValue(
      definition.runnable.input,
      definition.input,
      `schedule input [${definition.name}]`,
    )
  } catch (error) {
    throw new Error(`Invalid schedule [${definition.name}] input`, {
      cause: error,
    })
  }
}

/**
 * Validating parser shared with `defineSchedule`, so a definition rejected at
 * build time cannot be accepted at reconcile time (or the other way around).
 */
export function parseScheduleCadence({
  name,
  cron,
  every,
}: {
  readonly name: string
  readonly cron?: string
  readonly every?: string
}): ScheduleCadence {
  const exclusive = `Schedule [${name}] must define exactly one of cron/every`

  if (cron !== undefined) {
    if (every !== undefined) throw new Error(exclusive)
    try {
      // A fixed epoch keeps validation independent of the current time.
      CronExpressionParser.parse(cron, { currentDate: new Date(0) })
    } catch (error) {
      throw new Error(`Invalid schedule [${name}] cron [${cron}]`, {
        cause: error,
      })
    }
    return { cron }
  }

  if (every === undefined) throw new Error(exclusive)

  const everyMs = parseDurationMs(every)
  if (everyMs === undefined || everyMs <= 0) {
    throw new Error(`Invalid schedule [${name}] every duration [${every}]`)
  }
  return { everyMs }
}

function nextScheduleRunAt(
  cadence: ScheduleCadence,
  now: Date,
  base: Date,
): Date {
  if (cadence.cron !== undefined) {
    return CronExpressionParser.parse(cadence.cron, {
      currentDate: now,
    })
      .next()
      .toDate()
  }

  if (cadence.everyMs === undefined || cadence.everyMs <= 0) {
    throw new Error('Schedule everyMs must be a positive number')
  }

  const elapsed = now.getTime() - base.getTime()
  const missed = Math.max(0, Math.floor(elapsed / cadence.everyMs))
  return new Date(base.getTime() + (missed + 1) * cadence.everyMs)
}
