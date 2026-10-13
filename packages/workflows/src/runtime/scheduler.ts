import { CronExpressionParser } from 'cron-parser'

import type { DefinitionBundle, GraphPresentation } from '../inspector/graph.ts'
import type {
  AnyScheduleDefinition,
  RunKind,
  ScheduleDefinition,
  Timestamp,
} from '../types/index.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from './executors.ts'
import type { StoredRun } from './state.ts'
import type { WorkflowStore } from './store.ts'
import { encodeStoredValue } from './codec.ts'
import { continueRunCommand } from './commands.ts'
import { dispatchTaskRunAttempt } from './coordinator/attempt.ts'
import { resolveTags } from './coordinator/codec.ts'
import { runDefinitionInput } from './definition.ts'
import { parseDurationMs } from './duration.ts'
import { WorkflowIdempotencyConflictError } from './errors.ts'
import { isTerminalRunStatus } from './status.ts'

export type StoredWorkflowSchedule = {
  readonly id: string
  readonly name: string
  readonly runnableKind: RunKind
  readonly runnableName: string
  /**
   * The revision and graph of the runnable the schedule was last reconciled
   * with. Every fire pins its run to them; a reconcile moves future slots only.
   * All three are absent on schedules saved before revisions existed.
   */
  readonly executionRevision?: string
  readonly graphHash?: string
  readonly graphPresentation?: GraphPresentation
  readonly input: unknown
  readonly tags: Readonly<Record<string, string>>
  readonly cron?: string
  readonly everyMs?: number
  readonly enabled: boolean
  readonly nextRunAt: Timestamp
  readonly lastSlotAt?: Timestamp
  readonly createdAt: Timestamp
  readonly updatedAt: Timestamp
}

export type WorkflowSchedulerFireDueOptions = {
  readonly now?: Timestamp
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
  readonly executionRevision?: string
  readonly graphHash: string
  readonly graphPresentation?: GraphPresentation
  /** Saved atomically with the schedule, so a fire never lacks its definitions. */
  readonly definitions: DefinitionBundle
  readonly input: unknown
  readonly tags: Readonly<Record<string, string>>
  readonly cron?: string
  readonly everyMs?: number
  readonly enabled: boolean
  readonly nextRunAt: Timestamp
}

export function normalizeScheduleDefinitions(
  definitions: readonly AnyScheduleDefinition[],
  now = Date.now(),
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
  now = Date.now(),
): NormalizedScheduleEntry {
  const cadence = normalizeScheduleCadence(definition)
  const runnableKind = definition.runnable.kind
  const runnableName = definition.runnable.name
  const input = definition.input
  const storedInput = encodeScheduleInput(definition)
  const nextRunAt =
    definition.immediately === true ? now : nextScheduleRunAt(cadence, now, now)
  const { executionRevision, graphHash, graphPresentation, definitions } =
    runDefinitionInput(definition.runnable)

  return {
    name: definition.name,
    runnableKind,
    runnableName,
    ...(executionRevision === undefined ? {} : { executionRevision }),
    graphHash: graphHash!,
    ...(graphPresentation === undefined ? {} : { graphPresentation }),
    definitions: definitions!,
    input: storedInput,
    tags: definition.tags ?? resolveTags(definition.runnable.tags, input) ?? {},
    ...cadence,
    enabled: definition.enabled ?? true,
    nextRunAt,
  }
}

export function nextStoredScheduleRunAt(
  schedule: Pick<StoredWorkflowSchedule, 'cron' | 'everyMs' | 'nextRunAt'>,
  now: Timestamp,
): Timestamp {
  return nextScheduleRunAt(schedule, now, schedule.nextRunAt)
}

type ScheduleRuntime = {
  readonly store: WorkflowStore
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly attemptExecutor: AttemptExecutor
}

export async function startStoredScheduleRun(
  runtime: ScheduleRuntime,
  schedule: StoredWorkflowSchedule,
  slot: Timestamp | 'manual',
): Promise<StoredRun> {
  // A slot identifies one recurring fire, so every scheduler instance derives
  // the same key for it. A manual trigger is its own event: a time-based key
  // would collapse triggers that land in the same millisecond.
  const idempotencyKey =
    slot === 'manual'
      ? ['$schedule', schedule.name, 'manual', crypto.randomUUID()]
      : ['$schedule', schedule.name, slot]
  const tags = { ...schedule.tags, schedule: schedule.name }
  const { executionRevision, graphHash, graphPresentation } = schedule
  const run = await createSlotRun(runtime, {
    kind: schedule.runnableKind,
    name: schedule.runnableName,
    workflowName: schedule.runnableName,
    ...(schedule.runnableKind === 'task'
      ? { taskName: schedule.runnableName }
      : {}),
    input: schedule.input,
    tags,
    idempotencyKey,
    ...(executionRevision === undefined ? {} : { executionRevision }),
    ...(graphHash === undefined ? {} : { graphHash }),
    ...(graphPresentation === undefined ? {} : { graphPresentation }),
  })
  // The slot's run may be one an earlier fire created and never acknowledged,
  // and by now be settled, or pinned to the schedule's previous target. So the
  // dispatch is derived from the run, never from the schedule.
  if (isTerminalRunStatus(run.status)) return run

  if (run.kind === 'task') {
    await dispatchTaskRunAttempt({
      store: runtime.store,
      attemptExecutor: runtime.attemptExecutor,
      runCoordinationExecutor: runtime.runCoordinationExecutor,
      taskName: run.taskName ?? run.name,
      revision: run.executionRevision,
      taskRunId: run.id,
      taskInput: run.input,
      idempotencyKey: run.idempotencyKey,
      throwOnDispatchFailure: true,
    })
    return run
  }

  await runtime.runCoordinationExecutor.enqueue(continueRunCommand(run))
  return run
}

/**
 * A fire that crashed after creating its run leaves the slot unacknowledged.
 * When the schedule was reconciled meanwhile with another revision, input or
 * target, firing the slot again conflicts on its key. That key is derived by
 * schedulers alone, so the run holding it is this slot's run: the fire adopts
 * it instead of failing forever or creating a second one. Client idempotency
 * is untouched; only this scheduler-owned key is recovered this way.
 */
async function createSlotRun(
  runtime: ScheduleRuntime,
  input: Parameters<WorkflowStore['createRun']>[0],
): Promise<StoredRun> {
  try {
    return await runtime.store.createRun(input)
  } catch (error) {
    if (!(error instanceof WorkflowIdempotencyConflictError)) throw error
    if (error.runId === undefined) throw error
    const [existing] = await runtime.store.loadRuns([error.runId])
    if (
      !existing ||
      JSON.stringify(existing.idempotencyKey) !==
        JSON.stringify(input.idempotencyKey)
    ) {
      throw error
    }
    return existing
  }
}

function encodeScheduleInput(definition: ScheduleDefinition): unknown {
  try {
    return encodeStoredValue(
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
  now: Timestamp,
  base: Timestamp,
): Timestamp {
  if (cadence.cron !== undefined) {
    return CronExpressionParser.parse(cadence.cron, {
      currentDate: now,
    })
      .next()
      .getTime()
  }

  if (cadence.everyMs === undefined || cadence.everyMs <= 0) {
    throw new Error('Schedule everyMs must be a positive number')
  }

  const elapsed = now - base
  const missed = Math.max(0, Math.floor(elapsed / cadence.everyMs))
  return base + (missed + 1) * cadence.everyMs
}
