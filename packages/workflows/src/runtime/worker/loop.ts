import type { DurationString } from '../../types/index.ts'
import type { WorkflowScheduler } from '../scheduler.ts'
import type {
  PruneTerminalRunsParams,
  WorkflowRetentionPruner,
  WorkflowStore,
} from '../store.ts'
import { parseDurationMs } from '../duration.ts'

export const DEFAULT_LEASE_MS = 30_000

export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  assertPositiveInteger(concurrency, 'Concurrency')

  let nextIndex = 0

  async function runWorker(): Promise<void> {
    while (nextIndex < items.length) {
      const item = items[nextIndex]
      nextIndex += 1
      await worker(item)
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, runWorker),
  )
}

export type WorkerLoopResult = {
  readonly processed: number
}

export type WorkerRetentionOptions = {
  readonly olderThan: DurationString
  readonly everyMs?: number
  readonly batchSize?: number
  readonly statuses?: PruneTerminalRunsParams['statuses']
}

export type WorkerSchedulingOptions = {
  readonly everyMs?: number
  readonly batchSize?: number
}

export type WorkerMaintenanceHook = {
  readonly everyMs: number
  readonly run: (now: Date) => Promise<void>
}

export type WorkerLoopOptions = {
  readonly workerId: string
  readonly concurrency?: number
  readonly leaseMs?: number
  readonly maxIdleClaims?: number
  readonly idleDelayMs?: number
  readonly retention?: WorkerRetentionOptions
  readonly retentionPruner?: WorkflowRetentionPruner
  readonly scheduling?: WorkerSchedulingOptions
  readonly scheduler?: WorkflowScheduler
  readonly maintenance?: readonly WorkerMaintenanceHook[]
  readonly signal?: AbortSignal
}

export async function runWorkerLoop(
  options: WorkerLoopOptions,
  claimAndRun: () => Promise<boolean>,
): Promise<WorkerLoopResult> {
  const concurrency = options.concurrency ?? 1
  const maxIdleClaims = options.maxIdleClaims ?? 1
  assertPositiveInteger(concurrency, 'Concurrency')
  assertPositiveInteger(maxIdleClaims, 'Max idle claims')

  let processed = 0
  let firstError: unknown
  let stopped = false
  let lastRetentionAt = 0
  let lastSchedulingAt = 0
  let retentionRunning = false
  let schedulingRunning = false
  const runRetentionPrune = async () => {
    if (!options.retention || !options.retentionPruner) return
    const everyMs = options.retention.everyMs ?? 60_000
    if (!Number.isFinite(everyMs) || everyMs < 0) {
      throw new Error('Retention everyMs must be a non-negative number')
    }
    const date = Date.now()
    if (retentionRunning || date - lastRetentionAt < everyMs) return

    const olderThanMs = parseDurationMs(options.retention.olderThan)
    if (olderThanMs === undefined) {
      throw new Error(
        `Invalid retention olderThan duration [${options.retention.olderThan}]`,
      )
    }

    retentionRunning = true
    lastRetentionAt = date
    try {
      await options.retentionPruner.pruneTerminalRuns({
        olderThan: new Date(date - olderThanMs),
        batchSize: options.retention.batchSize,
        statuses: options.retention.statuses,
      })
    } finally {
      retentionRunning = false
    }
  }
  const maintenanceState = (options.maintenance ?? []).map(() => ({
    lastAt: 0,
    running: false,
  }))
  const runMaintenance = async () => {
    const hooks = options.maintenance ?? []
    for (const [index, hook] of hooks.entries()) {
      const state = maintenanceState[index]!
      if (!Number.isFinite(hook.everyMs) || hook.everyMs < 0) {
        throw new Error('Maintenance everyMs must be a non-negative number')
      }
      const date = Date.now()
      if (state.running || date - state.lastAt < hook.everyMs) continue

      state.running = true
      state.lastAt = date
      try {
        await hook.run(new Date(date))
      } finally {
        state.running = false
      }
    }
  }
  const runScheduling = async () => {
    if (!options.scheduling || !options.scheduler) return
    const everyMs = options.scheduling.everyMs ?? 1_000
    if (!Number.isFinite(everyMs) || everyMs < 0) {
      throw new Error('Scheduling everyMs must be a non-negative number')
    }
    const date = Date.now()
    if (schedulingRunning || date - lastSchedulingAt < everyMs) return

    schedulingRunning = true
    lastSchedulingAt = date
    try {
      await options.scheduler.fireDue({
        now: new Date(date),
        limit: options.scheduling.batchSize,
      })
    } finally {
      schedulingRunning = false
    }
  }
  await Promise.allSettled(
    Array.from({ length: concurrency }, async () => {
      let idleClaims = 0
      try {
        while (
          !stopped &&
          !options.signal?.aborted &&
          idleClaims < maxIdleClaims
        ) {
          const didWork = await claimAndRun()
          if (didWork) {
            processed += 1
            idleClaims = 0
            continue
          }

          idleClaims += 1
          await runRetentionPrune()
          await runScheduling()
          await runMaintenance()
          if (idleClaims < maxIdleClaims) {
            await sleep(options.idleDelayMs ?? 0, options.signal)
          }
        }
      } catch (error) {
        stopped = true
        firstError ??= error
      }
    }),
  )

  if (firstError) throw firstError
  return { processed }
}

export function withDefaultRetentionPruner<
  Input extends WorkerLoopOptions & { readonly store: WorkflowStore },
>(input: Input): Input {
  if (input.retentionPruner) return input
  return { ...input, retentionPruner: input.store }
}

async function sleep(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (ms <= 0 || signal?.aborted) return

  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', done)
      resolve()
    }

    const timeout = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
}

export function isStaleWorkflowCommandAck(error: unknown): boolean {
  return (
    error instanceof Error && error.message === 'Stale workflow command ack'
  )
}

export function isAttemptHeartbeatLeaseLost(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Workflow attempt heartbeat lease lost'
  )
}
