import type { WorkflowRuntimeAdapter } from '../../runtime/client.ts'
import type {
  AttemptCommand,
  ContinueRunCommand,
  TaskAttemptCommand,
} from '../../runtime/commands.ts'
import type { WorkflowRuntimeAtomicStart } from '../../runtime/coordinator.ts'
import type { DispatchTaskRunAttemptInput } from '../../runtime/coordinator/attempt.ts'
import type { AttemptDispatchOptions } from '../../runtime/executors.ts'
import type {
  CreateRunInput,
  DeadWorkflowCommand,
} from '../../runtime/store.ts'
import type { WorkflowRedisClient } from './client.ts'
import { dispatchTaskRunAttempt } from '../../runtime/coordinator/attempt.ts'
import { DEFAULT_LEASE_MS } from '../../runtime/executors.ts'
import { isTerminalRunStatus } from '../../runtime/status.ts'
import { Keys } from './keys.ts'
import { Queue } from './queue.ts'
import { StoreRuntime } from './store.ts'
import { WakeEvents } from './wake-events.ts'

const DEFAULT_KEY_PREFIX = 'nmtjs:workflows:'
const DEFAULT_TERMINAL_RETENTION_MS = 15 * 60 * 1_000
const DEFAULT_MAX_DELIVERIES = 20

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] }

export type CreateRedisWorkflowRuntimeParams = {
  /**
   * A caller-owned ioredis or iovalkey client. The runtime duplicates it for
   * Pub/Sub, but dispose() deliberately leaves this command client open.
   * Configure finite commandTimeout and maxRetriesPerRequest values; unlimited
   * request retries can leave a workflow operation pending across reconnects.
   */
  readonly client: WorkflowRedisClient
  /** Isolates independent runtimes that share one Redis database. */
  readonly keyPrefix?: string
  /**
   * Retention begins only after every run in the root run's family is
   * terminal. Active families never receive a TTL.
   */
  readonly terminalRetentionMs?: number
  readonly maxDeliveries?: number
}

export type RedisWorkflowRuntime = WorkflowRuntimeAdapter & {
  readonly client: WorkflowRedisClient
  readonly keyPrefix: string
}

export function createRedisWorkflowRuntime(
  params: CreateRedisWorkflowRuntimeParams,
): RedisWorkflowRuntime {
  const { client } = params
  const keyPrefix = params.keyPrefix ?? DEFAULT_KEY_PREFIX
  const terminalRetentionMs =
    params.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS
  const maxDeliveries = params.maxDeliveries ?? DEFAULT_MAX_DELIVERIES
  assertPositiveInteger('terminalRetentionMs', terminalRetentionMs)
  assertPositiveInteger('maxDeliveries', maxDeliveries)

  const keys = new Keys(keyPrefix)
  const wakeEvents = new WakeEvents(client, keys)
  const continueQueue = new Queue<ContinueRunCommand>({
    client,
    keys,
    kind: 'continue',
    maxDeliveries,
    dedupKey: (command) => command.runId,
  })
  const attemptQueue = new Queue<AttemptCommand>({
    client,
    keys,
    kind: 'attempt',
    maxDeliveries,
    dedupKey: (command) => command.attemptId,
  })

  const storeRuntime = new StoreRuntime({
    client,
    keys,
    terminalRetentionMs,
    delegates: {
      async listDeadCommands(runId) {
        const groups = await Promise.all([
          continueQueue.listDead(runId),
          attemptQueue.listDead(runId),
        ])
        const commands = groups.flat()
        commands.sort(compareDeadNewest)
        return commands
      },
      async listUnreapedDeadCommands({ limit, commandId } = {}) {
        const groups = await Promise.all([
          continueQueue.listUnreaped(limit, commandId),
          attemptQueue.listUnreaped(limit, commandId),
        ])
        const commands = groups.flat()
        commands.sort(compareDeadOldest)
        if (limit !== undefined && commands.length > limit) {
          commands.length = limit
        }
        return commands
      },
      async markDeadCommandReaped(id) {
        const marked = await continueQueue.markReaped(id)
        if (marked) return
        await attemptQueue.markReaped(id)
      },
      async requeueDeadCommand(id) {
        const requeued = await continueQueue.requeueDead(id)
        if (requeued) return
        await attemptQueue.requeueDead(id)
      },
      async deleteCommands(runIds) {
        await Promise.all([
          continueQueue.deleteForRuns(runIds),
          attemptQueue.deleteForRuns(runIds),
        ])
      },
      async pruneDeadCommands(olderThan) {
        await Promise.all([
          continueQueue.prune(olderThan),
          attemptQueue.prune(olderThan),
        ])
      },
    },
  })

  const store = storeRuntime.store
  const runCoordinationExecutor: RedisWorkflowRuntime['runCoordinationExecutor'] =
    {
      enqueue: (command) => continueQueue.enqueue(command),
      enqueueDelayed: (command, runAt) => continueQueue.enqueue(command, runAt),
      claim: (worker) => continueQueue.claim(worker, worker.leaseMs),
      ack: (command) => continueQueue.ack(command),
      release: (command, options) => continueQueue.release(command, options),
    }
  const attemptExecutor: RedisWorkflowRuntime['attemptExecutor'] = {
    dispatchActivity: (command, options) =>
      attemptQueue.enqueue(command, options?.runAt),
    dispatchTask: (command, options) =>
      attemptQueue.enqueue(command, options?.runAt),
    claim: (worker) => attemptQueue.claim(worker, worker.leaseMs),
    heartbeat: async (attempt, leaseMs = DEFAULT_LEASE_MS) => {
      const result = await attemptQueue.heartbeat(attempt, leaseMs)
      if (!result) throw new Error('Workflow attempt heartbeat lease lost')
      return result
    },
    ack: (attempt) => attemptQueue.ack(attempt),
    release: (attempt, options) => attemptQueue.release(attempt, options),
    deleteUnclaimed: ({ runId }) =>
      attemptQueue.deleteUnclaimed(new Set([runId])),
  }

  // The start marker commits in the same Redis transaction as the initial
  // queue item. An idempotent retry can therefore distinguish "already
  // dispatched" from the narrow create-before-dispatch failure window and
  // repair only the latter.
  const atomicStart: WorkflowRuntimeAtomicStart = {
    startWorkflowRun: ({ run, startAt }) => startRun(run, startAt),
    startTaskRun: ({ run, taskName, taskInput, idempotencyKey, startAt }) => {
      const taskRun: Mutable<CreateRunInput> = {
        ...run,
        kind: 'task',
        taskName,
        input: taskInput,
      }
      if (idempotencyKey !== undefined) taskRun.idempotencyKey = idempotencyKey
      return startRun(taskRun, startAt)
    },
  }

  async function startRun(run: CreateRunInput, startAt?: Date) {
    const started = await storeRuntime.createRun(run, startAt)
    const stored = started.run
    if (isTerminalRunStatus(stored.status)) return stored
    const markerKey = keys.startDispatch(stored.id)
    if (!started.created && (await client.exists(markerKey))) {
      return stored
    }
    try {
      if (stored.kind === 'workflow') {
        await continueQueue.enqueueWithMarker(
          {
            kind: 'continueRun',
            runId: stored.id,
            workflowName: stored.workflowName,
          },
          markerKey,
          started.startAt,
        )
      } else {
        const startExecutor = {
          ...attemptExecutor,
          dispatchTask: (
            command: TaskAttemptCommand,
            options?: AttemptDispatchOptions,
          ) =>
            attemptQueue.enqueueWithMarker(command, markerKey, options?.runAt),
        }
        // A join can repair another caller's interrupted start. Its payload,
        // identity and schedule must come from that persisted run.
        const dispatch: Mutable<DispatchTaskRunAttemptInput> = {
          store,
          runCoordinationExecutor,
          attemptExecutor: startExecutor,
          taskName: stored.taskName ?? stored.name,
          taskRunId: stored.id,
          taskInput: stored.input,
          startAt: started.startAt,
          // A timeout may follow a committed dispatch; leave terminalization
          // to execution and allow the same start identity to repair a retry.
          throwOnDispatchFailure: false,
        }
        if (stored.idempotencyKey !== undefined) {
          dispatch.idempotencyKey = stored.idempotencyKey
        }
        await dispatchTaskRunAttempt(dispatch)
      }
    } catch (error) {
      if (await startMarkerExists(client, markerKey)) return stored
      throw error
    }
    return stored
  }

  return {
    store,
    runCoordinationExecutor,
    attemptExecutor,
    retentionPruner: store,
    wakeEvents,
    atomicStart,
    client,
    keyPrefix,
    dispose: () => wakeEvents.dispose(),
  }
}

const compareDeadNewest = (
  left: DeadWorkflowCommand,
  right: DeadWorkflowCommand,
) =>
  right.deadAt.getTime() - left.deadAt.getTime() ||
  right.id.localeCompare(left.id)

const compareDeadOldest = (
  left: DeadWorkflowCommand,
  right: DeadWorkflowCommand,
) =>
  left.deadAt.getTime() - right.deadAt.getTime() ||
  left.id.localeCompare(right.id)

const assertPositiveInteger = (name: string, value: number) => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Redis workflow ${name} must be a positive integer`)
  }
}

async function startMarkerExists(
  client: WorkflowRedisClient,
  markerKey: string,
) {
  try {
    return (await client.exists(markerKey)) === 1
  } catch {
    // The original dispatch error is more useful; an idempotent retry can
    // safely repair a start whose marker could not be inspected.
    return false
  }
}
