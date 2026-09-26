import type {
  Env,
  TaskImplementation,
  WorkflowImplementation,
} from '../../implement/index.ts'
import type {
  AnyTaskDefinition,
  AnyWorkflowDefinition,
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
import {
  createHandlerRunner,
  type HandlerRunner,
  type HandlerRunnerOptions,
} from '../handler.ts'
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
  const workflowNames = input.workflows.map(
    (implementation) => implementation.workflow.name,
  )
  return {
    claim: () =>
      input.runCoordinationExecutor.claim({
        workerId: input.workerId,
        workflowNames,
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
  // A workflow's activities all run on its pool, so its name routes them.
  const served = <T extends { readonly pool: string }>(
    implementations: readonly T[],
  ) =>
    input.pool === undefined
      ? implementations
      : implementations.filter(({ pool }) => pool === input.pool)
  const workflowNames = served(input.workflows).map(
    (implementation) => implementation.workflow.name,
  )
  const taskNames = served(input.tasks).map(
    (implementation) => implementation.task.name,
  )
  return {
    claim: () =>
      input.attemptExecutor.claim({
        workerId: input.workerId,
        workflowNames,
        taskNames,
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

/** Every pool named by an implementation, for checking against declared pools. */
export function collectImplementationPools(
  workflows: readonly Pick<AnyWorkflowImplementation, 'pool'>[],
  tasks: readonly Pick<AnyTaskImplementation, 'pool'>[],
): ReadonlySet<string> {
  return new Set([...workflows, ...tasks].map(({ pool }) => pool))
}

/**
 * Names that more than one definition object carries. Children and tasks are
 * resolved by name, so a same-named copy would be encoded with one schema and
 * decoded with another, and is the only way workflows could start each other in
 * a cycle: definitions cannot reference each other as objects.
 */
export function findConflictingDefinitions(
  workflows: readonly Pick<AnyWorkflowImplementation, 'workflow' | 'nodes'>[],
  tasks: readonly Pick<AnyTaskImplementation, 'task'>[],
): readonly string[] {
  // Workflows and tasks are separate namespaces, as in the registry.
  const seen = {
    workflow: new Map<string, object>(),
    task: new Map<string, object>(),
  }
  const conflicts = new Set<string>()
  const add = (definition: AnyWorkflowDefinition | AnyTaskDefinition) => {
    const known = seen[definition.kind].get(definition.name)
    if (known === undefined)
      seen[definition.kind].set(definition.name, definition)
    else if (known !== definition) conflicts.add(definition.name)
  }
  for (const { task } of tasks) add(task)
  for (const { workflow, nodes } of workflows) {
    add(workflow)
    for (const node of nodes) {
      if (node.kind === 'branch' || node.kind === 'parallel') {
        for (const member of Object.values(node.cases))
          if (member.kind !== 'activity') add(member.target)
      } else if (node.kind !== 'activity') add(node.target)
    }
  }
  return [...conflicts]
}

export function collectWorkflowTaskNames(
  workflows: readonly Pick<AnyWorkflowImplementation, 'nodes'>[],
): readonly string[] {
  const names = new Set<string>()
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      if (node.kind === 'task' || node.kind === 'mapTask') {
        names.add(node.target.name)
        continue
      }

      if (node.kind === 'branch' || node.kind === 'parallel') {
        for (const member of Object.values(node.cases)) {
          if (member.kind === 'task') names.add(member.target.name)
        }
      }
    }
  }

  return [...names]
}

export function collectChildWorkflowNames(
  workflows: readonly Pick<AnyWorkflowImplementation, 'nodes'>[],
): readonly string[] {
  const names = new Set<string>()
  for (const workflow of workflows) {
    for (const node of workflow.nodes) {
      if (node.kind === 'workflow' || node.kind === 'mapWorkflow') {
        names.add(node.target.name)
        continue
      }

      if (node.kind === 'branch' || node.kind === 'parallel') {
        for (const member of Object.values(node.cases)) {
          if (member.kind === 'workflow') names.add(member.target.name)
        }
      }
    }
  }

  return [...names]
}
