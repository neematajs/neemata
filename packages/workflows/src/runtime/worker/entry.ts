import type {
  Env,
  TaskImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  AnyScheduleDefinition,
  AnyTaskDefinition,
  AnyWorkflowDefinition,
  RunnableDefinition,
  Timestamp,
} from '../../types/index.ts'
import type { ClaimedAttempt, ClaimedCommand } from '../commands.ts'
import type { AttemptExecutor, RunCoordinationExecutor } from '../executors.ts'
import type { WorkflowStore } from '../store.ts'
import type {
  WorkflowCommandWakeKind,
  WorkflowWakeEvents,
} from '../wake-events.ts'
import { continueWorkflowRun } from '../coordinator.ts'
import { refKey } from '../definition.ts'
import { StaleWriteFenceError } from '../errors.ts'
import {
  createHandlerRunner,
  type HandlerRunner,
  type HandlerRunnerOptions,
} from '../handler.ts'
import { routeLabel, routeRef } from '../registry.ts'
import { runActivityAttempt } from './activity-attempt.ts'
import {
  runAtomicContinuation,
  type WorkflowRuntimeAtomicCompletion,
  type WorkflowRuntimeAtomicContinuation,
} from './atomic.ts'
import { isAttemptShutdown } from './heartbeat.ts'
import {
  DEFAULT_LEASE_MS,
  drainWorkerPool,
  isAttemptHeartbeatLeaseLost,
  isStaleWorkflowCommandAck,
  serveWorkerPool,
  withDefaultRetentionPruner,
  type WorkerDriver,
  type WorkerLoopOptions,
  type WorkerLoopResult,
  type WorkerMaintenanceHook,
} from './loop.ts'
import {
  reapDeadWorkflowCommands,
  timeoutExpiredWorkflowRuns,
} from './maintenance.ts'
import { runTaskAttempt } from './task-attempt.ts'

const DEFAULT_REAPING_EVERY_MS = 30_000
const DEFAULT_RUN_TIMEOUTS_EVERY_MS = 60_000

export type WorkerReapingOptions = {
  readonly everyMs?: number
  readonly batchSize?: number
}

export type WorkerRunTimeoutsOptions = {
  readonly everyMs?: number
  readonly batchSize?: number
}

type AnyWorkflowImplementation = WorkflowImplementation<
  AnyWorkflowDefinition,
  any
>
type AnyTaskImplementation = TaskImplementation<AnyTaskDefinition, any>

/**
 * A standalone worker bounds handler cleanup itself. A supervisor that owns the
 * env and must drain handlers before disposing it shares its runner instead.
 */
export type WorkerHandlers<E> = WorkerEnv<E> &
  (
    | (HandlerRunnerOptions & { readonly handlers?: undefined })
    | { readonly handlers: HandlerRunner }
  )

// Handlers that ignore their env, and lists in the erased form, require none.
type WorkerEnv<E> = unknown extends E
  ? { readonly env?: E }
  : { readonly env: E }

function resolveHandlers(input: WorkerHandlers<any>): HandlerRunner {
  return input.handlers ?? createHandlerRunner(input)
}

export type RunWorkflowWorkerInput<
  W extends AnyWorkflowImplementation = AnyWorkflowImplementation,
> = WorkerLoopOptions &
  WorkerHandlers<Env<W>> & {
    readonly store: WorkflowStore
    readonly runCoordinationExecutor: RunCoordinationExecutor
    readonly attemptExecutor: AttemptExecutor
    readonly atomicContinuation?: WorkflowRuntimeAtomicContinuation
    readonly wakeEvents?: WorkflowWakeEvents
    readonly workflows: readonly W[]
    readonly reaping?: false | WorkerReapingOptions
    readonly runTimeouts?: false | WorkerRunTimeoutsOptions
  }

export type RunExecutionWorkerInput<
  W extends AnyWorkflowImplementation = AnyWorkflowImplementation,
  T extends AnyTaskImplementation = AnyTaskImplementation,
> = WorkerLoopOptions &
  WorkerHandlers<Env<W | T>> & {
    readonly store: WorkflowStore
    readonly runCoordinationExecutor: RunCoordinationExecutor
    readonly attemptExecutor: AttemptExecutor
    readonly atomicCompletion?: WorkflowRuntimeAtomicCompletion
    readonly wakeEvents?: WorkflowWakeEvents
    readonly workflows: readonly W[]
    readonly tasks: readonly T[]
    /**
     * Serve only the tasks, and the activities of the workflows, implemented for
     * this pool. Omitted, the worker serves all of them.
     */
    readonly pool?: string
    readonly reaping?: false | WorkerReapingOptions
  }

type MaintenanceDeps = {
  readonly store: WorkflowStore
  readonly attemptExecutor: AttemptExecutor
  readonly runCoordinationExecutor: RunCoordinationExecutor
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly tasks?: readonly AnyTaskImplementation[]
  readonly maintenance?: readonly WorkerMaintenanceHook[]
  readonly reaping?: false | WorkerReapingOptions
}

// Reaping is on by default: a dead-lettered command must fail its run instead
// of leaving a zombie only the dead-command table knows about.
function withReapingHook(
  input: MaintenanceDeps,
): readonly WorkerMaintenanceHook[] {
  const hooks = [...(input.maintenance ?? [])]
  if (input.reaping !== false) {
    const options = input.reaping
    hooks.push({
      everyMs: options?.everyMs ?? DEFAULT_REAPING_EVERY_MS,
      run: async () => {
        await reapDeadWorkflowCommands({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          workflows: input.workflows,
          tasks: input.tasks,
          batchSize: options?.batchSize,
        })
      },
    })
  }
  return hooks
}

function withRunTimeoutsHook(
  input: RunWorkflowWorkerInput,
  hooks: readonly WorkerMaintenanceHook[],
): readonly WorkerMaintenanceHook[] {
  if (input.runTimeouts === false) return hooks
  const options = input.runTimeouts
  return [
    ...hooks,
    {
      everyMs: options?.everyMs ?? DEFAULT_RUN_TIMEOUTS_EVERY_MS,
      run: async (now: Timestamp) => {
        await timeoutExpiredWorkflowRuns({
          store: input.store,
          attemptExecutor: input.attemptExecutor,
          runCoordinationExecutor: input.runCoordinationExecutor,
          workflows: input.workflows,
          batchSize: options?.batchSize,
          now,
        })
      },
    },
  ]
}

function commandWake(
  wakeEvents: WorkflowWakeEvents | undefined,
  kind: WorkflowCommandWakeKind,
): ((listener: () => void) => () => void) | undefined {
  if (!wakeEvents) return undefined
  return (listener) => wakeEvents.onCommand(kind, listener)
}

function executionWake(
  wakeEvents: WorkflowWakeEvents | undefined,
): ((listener: () => void) => () => void) | undefined {
  if (!wakeEvents) return undefined
  return (listener) => {
    const unsubscribeActivity = wakeEvents.onCommand('activity', listener)
    const unsubscribeTask = wakeEvents.onCommand('task', listener)
    return () => {
      unsubscribeActivity()
      unsubscribeTask()
    }
  }
}

export async function runWorkflowWorker<W extends AnyWorkflowImplementation>(
  input: RunWorkflowWorkerInput<W>,
): Promise<WorkerLoopResult> {
  return drainWorkerPool(
    workflowWorkerOptions(input),
    workflowDriver(input, resolveHandlers(input)),
  )
}

export async function serveWorkflowWorker<W extends AnyWorkflowImplementation>(
  input: RunWorkflowWorkerInput<W> & { readonly signal: AbortSignal },
): Promise<WorkerLoopResult> {
  return serveWorkerPool(
    { ...workflowWorkerOptions(input), signal: input.signal },
    workflowDriver(input, resolveHandlers(input)),
  )
}

function workflowWorkerOptions(input: RunWorkflowWorkerInput) {
  const maintenance = withRunTimeoutsHook(input, withReapingHook(input))
  return withDefaultRetentionPruner({
    ...input,
    maintenance,
    onWake: commandWake(input.wakeEvents, 'continue'),
  })
}

function workflowDriver(
  input: RunWorkflowWorkerInput,
  handlers: HandlerRunner,
): WorkerDriver<ClaimedCommand> {
  const workflows = input.workflows.map(({ workflow }) => routeRef(workflow))
  return {
    claim: () =>
      input.runCoordinationExecutor.claim({
        workerId: input.workerId,
        workflows,
        leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      }),
    abandon: (claimed) => input.runCoordinationExecutor.release(claimed),
    // Signal only user handlers; storage operations still finish atomically.
    async execute(claimed, signal) {
      try {
        return await runAtomicContinuation(input, async (scoped) => {
          const leaseMs = input.leaseMs ?? DEFAULT_LEASE_MS
          const result = await continueWorkflowRun({
            store: scoped.store,
            runCoordinationExecutor: scoped.runCoordinationExecutor,
            attemptExecutor: scoped.attemptExecutor,
            handlers,
            env: input.env,
            signal,
            onError: input.onError,
            workflows: input.workflows,
            workerId: input.workerId,
            command: claimed.command,
            leaseMs,
          })
          if (result.status === 'unroutable') {
            await scoped.runCoordinationExecutor.release(claimed, {
              reason: 'unroutable',
              error: result.error,
            })
            return false
          }
          if (result.status !== 'processed') {
            await scoped.runCoordinationExecutor.release(claimed)
            return false
          }

          await scoped.runCoordinationExecutor.ack(claimed)
          return true
        })
      } catch (error) {
        if (isStaleWorkflowCommandAck(error)) {
          await input.runCoordinationExecutor.release(claimed)
          return false
        }
        await input.runCoordinationExecutor.release(claimed, { error })
        throw error
      }
    },
  }
}

export async function runExecutionWorker<
  W extends AnyWorkflowImplementation,
  T extends AnyTaskImplementation,
>(input: RunExecutionWorkerInput<W, T>): Promise<WorkerLoopResult> {
  return drainWorkerPool(
    executionWorkerOptions(input),
    executionDriver(input, resolveHandlers(input)),
  )
}

export async function serveExecutionWorker<
  W extends AnyWorkflowImplementation,
  T extends AnyTaskImplementation,
>(
  input: RunExecutionWorkerInput<W, T> & { readonly signal: AbortSignal },
): Promise<WorkerLoopResult> {
  return serveWorkerPool(
    { ...executionWorkerOptions(input), signal: input.signal },
    executionDriver(input, resolveHandlers(input)),
  )
}

function executionWorkerOptions(input: RunExecutionWorkerInput) {
  return withDefaultRetentionPruner({
    ...input,
    maintenance: withReapingHook(input),
    onWake: executionWake(input.wakeEvents),
  })
}

function executionDriver(
  input: RunExecutionWorkerInput,
  handlers: HandlerRunner,
): WorkerDriver<ClaimedAttempt> {
  // A workflow's activities all run on its pool, so its route routes them.
  // Revisions of one name may sit on different pools: each is its own route.
  const served = <T extends { readonly pool: string }>(
    implementations: readonly T[],
  ) =>
    input.pool === undefined
      ? implementations
      : implementations.filter(({ pool }) => pool === input.pool)
  const workflows = served(input.workflows).map(({ workflow }) =>
    routeRef(workflow),
  )
  const tasks = served(input.tasks).map(({ task }) => routeRef(task))
  return {
    claim: () =>
      input.attemptExecutor.claim({
        workerId: input.workerId,
        workflows,
        tasks,
        leaseMs: input.leaseMs ?? DEFAULT_LEASE_MS,
      }),
    abandon: (claimed) => input.attemptExecutor.release(claimed),
    async execute(claimed, signal) {
      try {
        const result =
          claimed.command.kind === 'activityAttempt'
            ? await runActivityAttempt({ ...input, handlers, claimed, signal })
            : await runTaskAttempt({ ...input, handlers, claimed, signal })
        return result.status === 'processed'
      } catch (error) {
        if (
          isStaleWorkflowCommandAck(error) ||
          // The attempt moved on without this worker; its outcome is not
          // this worker's to record.
          error instanceof StaleWriteFenceError ||
          isAttemptHeartbeatLeaseLost(error) ||
          isAttemptShutdown(error)
        ) {
          await input.attemptExecutor.release(claimed)
          return false
        }
        await input.attemptExecutor.release(claimed, { error })
        throw error
      }
    },
  }
}

export type VerifyWorkflowsRegistryInput = {
  readonly workflows: readonly AnyWorkflowImplementation[]
  readonly tasks?: readonly AnyTaskImplementation[]
  readonly schedules?: readonly AnyScheduleDefinition[]
  /** Pools the deployment runs workers for; omitted, pools are not checked. */
  readonly pools?: readonly string[]
}

/**
 * Checks that what a deployment serves is complete, before any worker starts. A
 * gap would otherwise leave durable commands stalled forever, and the worker
 * entry points accept partial lists on purpose, so hosts call this at startup.
 * Revisions of one name are separate entries: each needs its own implementation
 * and its own targets.
 */
export function verifyWorkflowsRegistry({
  workflows,
  tasks = [],
  schedules = [],
  pools,
}: VerifyWorkflowsRegistryInput): void {
  const definitions = [
    ...workflows.map(({ workflow }) => workflow),
    ...tasks.map(({ task }) => task),
  ]
  // The execution registry refuses a second implementation of a route only when
  // it is built, at claim time, where it would fail unrelated work as well.
  const registered = new Map<string, RunnableDefinition>()
  const duplicates = new Set<string>()
  for (const definition of definitions) {
    const key = refKey(definition)
    if (registered.has(key)) duplicates.add(definitionLabel(definition))
    registered.set(key, definition)
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Implementations [${Array.from(duplicates).join(', ')}] are registered more than once; a workflow or task takes exactly one implementation per revision`,
    )
  }

  const targets = collectTargets(workflows)
  const missing = { workflow: new Set<string>(), task: new Set<string>() }
  for (const target of targets) {
    if (registered.has(refKey(target))) continue
    missing[target.kind].add(routeLabel(target))
  }
  if (missing.workflow.size > 0) {
    throw new Error(
      `Workflows [${Array.from(missing.workflow).join(', ')}] referenced by registered workflows have no registered implementation`,
    )
  }
  if (missing.task.size > 0) {
    throw new Error(
      `Tasks [${Array.from(missing.task).join(', ')}] referenced by registered workflows have no registered implementation`,
    )
  }

  // A schedule starts its target by route as well: an unregistered one would
  // fire runs nobody can claim, and a same-named copy would encode its input
  // with another schema than the implementation decodes with.
  const unserved = new Set<string>()
  const conflicts = new Set<string>()
  for (const { runnable } of schedules) {
    const known = registered.get(refKey(runnable))
    if (known === undefined) unserved.add(routeLabel(runnable))
    else if (known !== runnable) conflicts.add(routeLabel(runnable))
  }
  if (unserved.size > 0) {
    throw new Error(
      `Workflows or tasks [${Array.from(unserved).join(', ')}] targeted by schedules have no registered implementation`,
    )
  }

  // Children and tasks are resolved by route, so a copy of a definition would be
  // encoded with one schema and decoded with another, and is the only way
  // workflows could start each other in a cycle: definitions cannot reference
  // each other as objects.
  for (const target of targets) {
    if (registered.get(refKey(target)) !== target) {
      conflicts.add(routeLabel(target))
    }
  }
  if (conflicts.size > 0) {
    throw new Error(
      `Definitions [${Array.from(conflicts).join(', ')}] exist as more than one object; a reference and its registered implementation must share one definition`,
    )
  }

  if (pools) {
    const declared = new Set(pools)
    const undeclared = new Set<string>()
    for (const { pool } of [...workflows, ...tasks]) {
      if (!declared.has(pool)) undeclared.add(pool)
    }
    if (undeclared.size > 0) {
      throw new Error(
        `Execution pools [${Array.from(undeclared).join(', ')}] named by implementations are not declared`,
      )
    }
  }
}

function definitionLabel(definition: RunnableDefinition) {
  return `${definition.kind}:${routeLabel(definition)}`
}

/** Every task and child workflow the workflows reference, each object once. */
function collectTargets(
  workflows: readonly Pick<AnyWorkflowImplementation, 'nodes'>[],
): ReadonlySet<RunnableDefinition> {
  const targets = new Set<RunnableDefinition>()
  for (const { nodes } of workflows) {
    for (const node of nodes) {
      if (node.kind === 'branch' || node.kind === 'parallel') {
        for (const member of Object.values(node.cases)) {
          if (member.kind !== 'activity') targets.add(member.target)
        }
      } else if (node.kind !== 'activity') {
        targets.add(node.target)
      }
    }
  }
  return targets
}
