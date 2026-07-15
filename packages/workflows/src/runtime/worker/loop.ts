import { setTimeout as wait } from 'node:timers/promises'

import type { DurationString } from '../../types/index.ts'
import type { WorkflowScheduler } from '../scheduler.ts'
import type {
  PruneTerminalRunsParams,
  WorkflowRetentionPruner,
  WorkflowStore,
} from '../store.ts'
import { parseDurationMs } from '../duration.ts'

export const DEFAULT_LEASE_MS = 30_000

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
  readonly idleDelayMs?: number
  /**
   * Push-style wake hint: subscribes a listener that short-circuits the idle
   * delay when new work may be claimable. Polling stays the fallback.
   */
  readonly onWake?: (listener: () => void) => () => void
  readonly retention?: WorkerRetentionOptions
  readonly retentionPruner?: WorkflowRetentionPruner
  readonly scheduling?: WorkerSchedulingOptions
  readonly scheduler?: WorkflowScheduler
  readonly maintenance?: readonly WorkerMaintenanceHook[]
  readonly signal?: AbortSignal
}

export type WorkerDriver<Claimed> = {
  readonly claim: () => Promise<Claimed | null>
  readonly execute: (claimed: Claimed, signal: AbortSignal) => Promise<boolean>
}

export function drainWorkerPool<Claimed>(
  options: WorkerLoopOptions,
  driver: WorkerDriver<Claimed>,
): Promise<WorkerLoopResult> {
  return runWorkerPool(options, driver, 'drain')
}

export function serveWorkerPool<Claimed>(
  options: WorkerLoopOptions & { readonly signal: AbortSignal },
  driver: WorkerDriver<Claimed>,
): Promise<WorkerLoopResult> {
  return runWorkerPool(options, driver, 'serve')
}

type WorkerMode = 'drain' | 'serve'

type PeriodicTask = {
  readonly everyMs: number
  readonly run: (now: Date) => Promise<void>
  nextAt: number
}

async function runWorkerPool<Claimed>(
  options: WorkerLoopOptions,
  driver: WorkerDriver<Claimed>,
  mode: WorkerMode,
): Promise<WorkerLoopResult> {
  const concurrency = options.concurrency ?? 1
  assertPositiveInteger(concurrency, 'Concurrency')
  if (options.idleDelayMs !== undefined) {
    assertNonNegative(options.idleDelayMs, 'Idle delay')
  }

  const periodicTasks = resolvePeriodicTasks(options)

  let processed = 0
  let failed = false
  let firstError: unknown
  const lifecycle = new AbortController()
  const executions = new AbortController()
  const wake = createWakeSignal(options.onWake)
  const forwardAbort = () => {
    lifecycle.abort(options.signal?.reason)
    executions.abort(options.signal?.reason)
    wake.notify()
  }
  if (options.signal?.aborted) forwardAbort()
  else options.signal?.addEventListener('abort', forwardAbort, { once: true })

  const active = new Set<Promise<void>>()
  const fail = (error: unknown) => {
    if (!failed) firstError = error
    failed = true
    // Claimed siblings finish normally so their leases are not needlessly
    // abandoned and redelivered after an unrelated execution fails.
    lifecycle.abort(error)
    wake.notify()
  }
  const startExecution = (claimed: Claimed) => {
    const task = driver
      .execute(claimed, executions.signal)
      .then((didProcess) => {
        if (didProcess) processed += 1
      })
      .catch(fail)
      .finally(() => {
        active.delete(task)
        wake.notify()
      })
    active.add(task)
  }
  const periodic =
    mode === 'serve' && periodicTasks.length > 0
      ? runPeriodicLoop(periodicTasks, lifecycle.signal, wake.notify).catch(
          fail,
        )
      : undefined

  let drainPeriodicPending = mode === 'drain' && periodicTasks.length > 0
  try {
    while (!lifecycle.signal.aborted) {
      let queueEmpty = false
      while (active.size < concurrency && !lifecycle.signal.aborted) {
        let claimed: Claimed | null
        try {
          claimed = await driver.claim()
        } catch (error) {
          fail(error)
          break
        }
        if (claimed === null) {
          queueEmpty = true
          break
        }

        startExecution(claimed)
      }
      if (lifecycle.signal.aborted) break

      if (queueEmpty) {
        if (active.size > 0) {
          // Polling still discovers due work when an adapter has no wake source.
          await wake.wait(
            Math.max(1, options.idleDelayMs ?? 250),
            lifecycle.signal,
          )
          continue
        }

        if (wake.consume()) continue

        if (mode === 'drain') {
          if (!drainPeriodicPending) break
          drainPeriodicPending = false
          try {
            await runDuePeriodicTasks(periodicTasks)
          } catch (error) {
            fail(error)
            break
          }
          // Maintenance can enqueue immediately claimable work.
          continue
        }

        await wake.wait(
          Math.max(1, options.idleDelayMs ?? 250),
          lifecycle.signal,
        )
        continue
      }

      // A full pool only needs a completion; durable wakes remain claimable.
      await wake.wait(undefined, lifecycle.signal)
    }
  } finally {
    lifecycle.abort()
    wake.notify()
    await Promise.allSettled(active)
    await periodic
    wake.dispose()
    options.signal?.removeEventListener('abort', forwardAbort)
  }

  if (failed) throw firstError
  return { processed }
}

function resolvePeriodicTasks(options: WorkerLoopOptions): PeriodicTask[] {
  const tasks: PeriodicTask[] = []
  if (options.retention && options.retentionPruner) {
    const everyMs = options.retention.everyMs ?? 60_000
    assertNonNegative(everyMs, 'Retention everyMs')
    const olderThanMs = parseDurationMs(options.retention.olderThan)
    if (olderThanMs === undefined) {
      throw new Error(
        `Invalid retention olderThan duration [${options.retention.olderThan}]`,
      )
    }
    tasks.push({
      everyMs,
      nextAt: 0,
      run: (now) =>
        options
          .retentionPruner!.pruneTerminalRuns({
            olderThan: new Date(now.getTime() - olderThanMs),
            batchSize: options.retention!.batchSize,
            statuses: options.retention!.statuses,
          })
          .then(() => undefined),
    })
  }
  if (options.scheduling && options.scheduler) {
    const everyMs = options.scheduling.everyMs ?? 1_000
    assertNonNegative(everyMs, 'Scheduling everyMs')
    tasks.push({
      everyMs,
      nextAt: 0,
      run: (now) =>
        options
          .scheduler!.fireDue({
            now,
            limit: options.scheduling!.batchSize,
          })
          .then(() => undefined),
    })
  }
  for (const hook of options.maintenance ?? []) {
    assertNonNegative(hook.everyMs, 'Maintenance everyMs')
    tasks.push({ ...hook, nextAt: 0 })
  }
  return tasks
}

async function runPeriodicLoop(
  tasks: PeriodicTask[],
  signal: AbortSignal,
  notify: () => void,
): Promise<void> {
  while (!signal.aborted) {
    await runDuePeriodicTasks(tasks)
    notify()
    const nextAt = Math.min(...tasks.map((task) => task.nextAt))
    // A zero interval remains useful for tests and eager maintenance, but a
    // timer floor prevents it from becoming an unbounded microtask loop.
    try {
      await wait(Math.max(1, nextAt - Date.now()), undefined, { signal })
    } catch (error) {
      if (!signal.aborted) throw error
    }
  }
}

async function runDuePeriodicTasks(tasks: PeriodicTask[]): Promise<void> {
  for (const task of tasks) {
    const date = Date.now()
    if (date < task.nextAt) continue
    task.nextAt = date + task.everyMs
    await task.run(new Date(date))
  }
}

function createWakeSignal(subscribe: WorkerLoopOptions['onWake']): {
  readonly notify: () => void
  readonly consume: () => boolean
  readonly wait: (
    timeoutMs: number | undefined,
    signal: AbortSignal,
  ) => Promise<void>
  readonly dispose: () => void
} {
  let pending = false
  let waiter: (() => void) | undefined
  const notify = () => {
    pending = true
    waiter?.()
  }
  const consume = () => {
    if (!pending) return false
    pending = false
    return true
  }
  const unsubscribe = subscribe?.(notify)

  return {
    notify,
    consume,
    async wait(timeoutMs, signal) {
      if (signal.aborted) return
      if (consume()) return

      const reason = await new Promise<'notified' | 'timeout' | 'aborted'>(
        (resolve) => {
          let settled = false
          let timeout: ReturnType<typeof setTimeout> | undefined
          const finish = (result: 'notified' | 'timeout' | 'aborted') => {
            if (settled) return
            settled = true
            if (timeout !== undefined) clearTimeout(timeout)
            if (waiter === onNotify) waiter = undefined
            signal.removeEventListener('abort', onAbort)
            resolve(result)
          }
          const onNotify = () => finish('notified')
          const onAbort = () => finish('aborted')

          waiter = onNotify
          signal.addEventListener('abort', onAbort, { once: true })
          if (timeoutMs !== undefined) {
            timeout = setTimeout(() => finish('timeout'), timeoutMs)
          }
        },
      )
      if (reason === 'notified') consume()
    },
    dispose() {
      unsubscribe?.()
    },
  }
}

export function withDefaultRetentionPruner<
  Input extends WorkerLoopOptions & { readonly store: WorkflowStore },
>(input: Input): Input {
  if (input.retentionPruner) return input
  return { ...input, retentionPruner: input.store }
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`)
  }
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`)
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
