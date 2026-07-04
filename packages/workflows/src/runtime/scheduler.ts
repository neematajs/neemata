import { CronExpressionParser } from 'cron-parser'

import type {
  AnyScheduleDefinition,
  RunKind,
  ScheduleDefinition,
} from '../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type { StoredRun } from './state.ts'
import type { WorkflowStore } from './store.ts'
import { dispatchTaskRunAttempt } from './coordinator/attempt.ts'
import { decodeSchemaValue } from './coordinator/codec.ts'
import { parseDurationMs } from './duration.ts'

export type StoredWorkflowSchedule = {
  readonly id: string
  readonly name: string
  readonly runnableKind: RunKind
  readonly runnableName: string
  readonly input: unknown
  readonly tags: Readonly<Record<string, string>>
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

export type NormalizedScheduleEntry = {
  readonly name: string
  readonly runnableKind: RunKind
  readonly runnableName: string
  readonly input: unknown
  readonly tags: Readonly<Record<string, string>>
  readonly cron?: string
  readonly everyMs?: number
  readonly enabled: boolean
  readonly nextRunAt: Date
}

export function normalizeScheduleDefinitions(
  definitions: readonly AnyScheduleDefinition[],
  now = new Date(),
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

export function normalizeScheduleDefinition(
  definition: AnyScheduleDefinition,
  now = new Date(),
): NormalizedScheduleEntry {
  const cadence = normalizeScheduleCadence(definition)
  const runnableKind = definition.runnable.kind
  const runnableName = definition.runnable.name
  const input = decodeScheduleInput(definition)
  const nextRunAt =
    definition.immediately === true ? now : nextScheduleRunAt(cadence, now, now)

  return {
    name: definition.name,
    runnableKind,
    runnableName,
    input,
    tags: definition.tags ?? {},
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
    await dispatchTaskRunAttempt({
      store: runtime.store,
      attemptExecutor: runtime.attemptExecutor,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      taskName: schedule.runnableName,
      taskRunId: run.id,
      taskInput: schedule.input,
      idempotencyKey,
      throwOnDispatchFailure: true,
    })
    return run
  }

  await runtime.runCoordinationExecutor.enqueue({
    kind: 'continueRun',
    runId: run.id,
    workflowName: schedule.runnableName,
  })
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

function normalizeScheduleCadence(input: {
  readonly name: string
  readonly cron?: string
  readonly every?: string
}): Pick<NormalizedScheduleEntry, 'cron' | 'everyMs'> {
  const cadenceCount =
    (input.cron === undefined ? 0 : 1) + (input.every === undefined ? 0 : 1)
  if (cadenceCount !== 1) {
    throw new Error(
      `Schedule [${input.name}] must define exactly one of cron/every`,
    )
  }

  if (input.every !== undefined) {
    const everyMs = parseDurationMs(input.every)
    if (everyMs === undefined || everyMs <= 0) {
      throw new Error(
        `Invalid schedule [${input.name}] every duration [${input.every}]`,
      )
    }
    return { everyMs }
  }

  try {
    CronExpressionParser.parse(input.cron!, { currentDate: new Date(0) })
    return { cron: input.cron! }
  } catch (error) {
    throw new Error(`Invalid schedule [${input.name}] cron [${input.cron!}]`, {
      cause: error,
    })
  }
}

function nextScheduleRunAt(
  cadence: Pick<StoredWorkflowSchedule, 'cron' | 'everyMs'>,
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
