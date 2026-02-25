import type { MessagePort, WorkerOptions } from 'node:worker_threads'
import EventEmitter, { once } from 'node:events'
import { MessageChannel, Worker } from 'node:worker_threads'

import type { Logger } from '@nmtjs/core'

import type { WorkerType } from '../enums.ts'
import type {
  JobTaskResult,
  ServerPortMessageTypes,
  ThreadErrorMessage,
  ThreadPortMessage,
  ThreadPortMessageTypes,
  WorkerJobTask,
  WorkerThreadError,
} from '../types.ts'
import type { ErrorPolicy, WorkerErrorContext } from './error-policy.ts'

const omitExecArgv = ['--expose-gc']

/**
 * States in the worker state machine.
 */
export type WorkerState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'error'
  | 'restarting'
  | 'stopping'
  | 'stopped'

/**
 * Context tracked for each managed worker.
 */
export interface ManagedWorkerContext {
  consecutiveFailures: number
  totalFailures: number
  lastStableTime: number | null
  lastError: Error | null
}

/**
 * Configuration for creating a managed worker.
 */
export interface ManagedWorkerConfig {
  id: string
  name: string
  index: number
  workerType: WorkerType
  path: string
  workerData?: any
  workerOptions?: Partial<WorkerOptions>
  onWorker?: (worker: Worker) => void
}

/**
 * Events emitted by ManagedWorker.
 */
export interface ManagedWorkerEvents {
  'state-change': [from: WorkerState, to: WorkerState]
  ready: [hosts?: ThreadPortMessageTypes['ready']['hosts']]
  error: [error: WorkerThreadError]
  task: [data: ThreadPortMessageTypes['task']]
}

/**
 * Time window (ms) after which a worker is considered "stable".
 * Used to reset consecutive failure count.
 */
const STABILITY_WINDOW_MS = 30_000

/**
 * Worker startup timeout (ms).
 */
const STARTUP_TIMEOUT_MS = 15_000

/**
 * Worker stop timeout (ms).
 */
const STOP_TIMEOUT_MS = 10_000

/**
 * ManagedWorker wraps a Node.js Worker thread with:
 * - Explicit state machine
 * - Automatic restart with exponential backoff
 * - Error tracking and stability detection
 * - Integration with ErrorPolicy for restart decisions
 *
 * State Machine:
 * - idle: Initial state, worker not created
 * - starting: Worker created, waiting for ready message
 * - ready: Worker is running and healthy
 * - error: Worker crashed or failed to start
 * - restarting: Worker is scheduled for restart (waiting for delay)
 * - stopping: Worker is being terminated
 * - stopped: Worker has been terminated (terminal state)
 */
export class ManagedWorker extends EventEmitter<ManagedWorkerEvents> {
  protected state: WorkerState = 'idle'
  protected ctx: ManagedWorkerContext = {
    consecutiveFailures: 0,
    totalFailures: 0,
    lastStableTime: null,
    lastError: null,
  }
  protected worker: Worker | null = null
  protected port: MessagePort | null = null
  protected restartTimer: ReturnType<typeof setTimeout> | null = null
  protected startPromise: Promise<void> | null = null
  protected pendingTaskIds = new Set<string>()
  protected logger: Logger

  constructor(
    readonly config: ManagedWorkerConfig,
    protected readonly policy: ErrorPolicy,
    logger: Logger,
  ) {
    super()
    this.logger = logger.child({
      component: 'ManagedWorker',
      workerId: config.id,
    })
  }

  /** Current worker state */
  get currentState(): WorkerState {
    return this.state
  }

  /** Whether the worker is healthy (ready state) */
  get isHealthy(): boolean {
    return this.state === 'ready'
  }

  /** Get a copy of the worker context */
  get context(): ManagedWorkerContext {
    return { ...this.ctx }
  }

  /**
   * Reset failure counts. Called when HMR update comes in to give the worker
   * a fresh start after code has been fixed.
   */
  resetFailureCount(): void {
    this.ctx.consecutiveFailures = 0
    this.ctx.lastError = null
  }

  /** Get the underlying Worker instance (if exists) */
  getWorker(): Worker | null {
    return this.worker
  }

  /**
   * Start the worker.
   * Can only be called from 'idle' or 'error' states.
   */
  async start(): Promise<void> {
    if (this.state === 'ready') return
    if (this.startPromise) return this.startPromise
    this.assertState('idle', 'error')

    this.startPromise = this.doStart()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  /**
   * Stop the worker.
   * Can be called from any state except 'stopped'.
   * Clears any pending restart timers and rejects pending run() tasks.
   */
  async stop(): Promise<void> {
    this.clearRestartTimer()

    if (this.state === 'stopped') return
    this.transition('stopping')

    // Reject any pending run() calls that are waiting for task results.
    // Without this, callers of pool.run() would hang forever since the
    // port is about to be closed and task-* events will never fire.
    this.rejectPendingTasks()

    try {
      await this.terminateWorker()
    } finally {
      this.cleanup()
      this.transition('stopped')
    }
  }

  /**
   * Run a task on this worker (for job workers).
   * The worker must be in 'ready' state.
   */
  async run(task: WorkerJobTask): Promise<JobTaskResult> {
    if (this.state !== 'ready' || !this.port) {
      throw new Error('Worker is not ready to run tasks')
    }

    const id = crypto.randomUUID()
    this.pendingTaskIds.add(id)
    this.send('task', { id, task })

    try {
      const [result] = (await once(this, `task-${id}` as any)) as [
        JobTaskResult,
      ]
      return result
    } finally {
      this.pendingTaskIds.delete(id)
    }
  }

  /**
   * Send a message to the worker.
   */
  send<T extends keyof ServerPortMessageTypes>(
    type: T,
    ...[data]: ServerPortMessageTypes[T] extends undefined
      ? []
      : [data: ServerPortMessageTypes[T]]
  ): void {
    this.port?.postMessage({ type, data })
  }

  /**
   * Internal: Start the worker and wait for it to be ready.
   */
  protected async doStart(): Promise<void> {
    this.transition('starting')

    try {
      const { port1, port2 } = new MessageChannel()
      this.port = port1

      const { config } = this
      this.worker = new Worker(config.path, {
        ...config.workerOptions,
        execArgv: process.execArgv.filter((f) => !omitExecArgv.includes(f)),
        workerData: { ...config.workerData, port: port2 },
        name: `${config.name}-${config.index + 1}`,
        transferList: [port2],
      })

      // Notify callback if provided
      config.onWorker?.(this.worker)

      // Set up message handling
      this.attachListeners()

      // Wait for ready with timeout
      await this.waitForReady()
    } catch (error) {
      this.handleError(error as Error)
      throw error
    }
  }

  /**
   * Wait for the worker to emit a 'ready' message or timeout.
   */
  protected waitForReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout>

      const cleanup = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.off('ready', handleReady)
        this.off('error', handleError)
      }

      const handleReady = () => {
        cleanup()
        resolve()
      }

      const handleError = (error: WorkerThreadError) => {
        cleanup()
        reject(error)
      }

      this.once('ready', handleReady)
      this.once('error', handleError)

      timer = setTimeout(() => {
        const error = createWorkerThreadError({
          message: `Worker thread ${this.config.id} did not become ready in time`,
          name: 'WorkerStartupTimeoutError',
          origin: 'start',
          fatal: true,
        })
        cleanup()
        this.handleError(error)
        reject(error)
      }, STARTUP_TIMEOUT_MS)
    })
  }

  /**
   * Attach listeners for port and worker events.
   */
  protected attachListeners(): void {
    if (!this.port || !this.worker) return

    this.port.on('message', (msg: ThreadPortMessage) => {
      const { type, data } = msg
      switch (type) {
        case 'ready':
          this.handleReady(data.hosts)
          break
        case 'error': {
          const error = createWorkerThreadError(data as ThreadErrorMessage)
          this.handleError(error)
          break
        }
        case 'task': {
          const taskData = data as ThreadPortMessageTypes['task']
          this.emit('task', taskData)
          this.emit(`task-${taskData.id}` as any, taskData.task)
          break
        }
      }
    })

    this.worker.once('exit', (code) => {
      // Ignore if we're already stopping/stopped
      if (this.state === 'stopping' || this.state === 'stopped') return

      const error = createWorkerThreadError({
        message: `Worker thread ${this.config.id} exited unexpectedly with code ${code}`,
        name: 'WorkerThreadExitError',
        origin: 'runtime',
        fatal: code !== 0,
      })
      this.handleError(error)
    })
  }

  /**
   * Handle worker ready event.
   */
  protected handleReady(
    hosts?: ThreadPortMessageTypes['ready']['hosts'],
  ): void {
    // Check if worker was stable before this (for failure count reset)
    if (
      this.ctx.lastStableTime !== null &&
      Date.now() - this.ctx.lastStableTime > STABILITY_WINDOW_MS
    ) {
      this.ctx.consecutiveFailures = 0
    }

    this.ctx.lastStableTime = Date.now()
    this.transition('ready')
    this.emit('ready', hosts)
  }

  /**
   * Handle worker error.
   */
  protected handleError(error: Error): void {
    const workerError = error as WorkerThreadError
    this.ctx.lastError = error
    this.ctx.consecutiveFailures++
    this.ctx.totalFailures++

    this.transition('error')
    if (this.listenerCount('error') > 0) {
      this.emit('error', workerError)
    } else {
      this.logger.error(workerError)
    }

    // Unblock any pending run() callers waiting for task-* events.
    // On runtime errors the current worker may never emit task completion.
    this.rejectPendingTasks()

    // Cleanup old worker
    this.terminateWorker().catch(() => {})
    this.cleanup()

    // Consult policy for action
    const errorContext: WorkerErrorContext = {
      workerId: this.config.id,
      workerType: this.config.workerType,
      consecutiveFailures: this.ctx.consecutiveFailures,
      totalFailures: this.ctx.totalFailures,
      lastStableTime: this.ctx.lastStableTime,
    }

    const action = this.policy.onWorkerError(workerError, errorContext)

    switch (action.type) {
      case 'restart':
        this.scheduleRestart(action.delay)
        break
      case 'exit':
        this.logger.fatal(
          new Error('Worker failed, exiting process', { cause: error }),
        )
        process.exit(action.code)
        break
      case 'wait':
        this.logger.debug('Worker failed, waiting for fix via HMR')
        break
      case 'ignore':
        this.logger.warn({ error }, 'Worker error ignored')
        break
    }
  }

  /**
   * Schedule a restart after the given delay.
   */
  protected scheduleRestart(delay: number): void {
    this.transition('restarting')
    this.logger.debug(
      { delay, attempt: this.ctx.consecutiveFailures },
      'Scheduling worker restart',
    )

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      // Reset to idle before starting
      this.transition('idle')
      this.start().catch((error) => {
        this.logger.error(new Error('Restart failed', { cause: error }))
      })
    }, delay)
  }

  /**
   * Clear any pending restart timer.
   */
  protected clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  /**
   * Terminate the underlying worker thread.
   */
  protected async terminateWorker(): Promise<void> {
    if (!this.worker) return

    const timeout = STOP_TIMEOUT_MS
    try {
      const signal = AbortSignal.timeout(timeout)
      const exitPromise = once(this.worker, 'exit', { signal })
      this.send('stop')
      this.port?.close()
      await exitPromise
    } catch {
      this.logger.warn(
        `Worker thread ${this.config.id} did not terminate in time, forcing termination`,
      )
      await this.worker.terminate()
    }
  }

  /**
   * Cleanup internal state.
   */
  protected cleanup(): void {
    this.worker = null
    this.port = null
  }

  /**
   * Reject all pending run() calls by emitting an error result
   * for each tracked task id. This unblocks callers waiting on
   * `once(this, 'task-<id>')` so they don't hang during shutdown.
   */
  protected rejectPendingTasks(): void {
    for (const id of this.pendingTaskIds) {
      const result: JobTaskResult = {
        type: 'error',
        error: new Error('Worker is shutting down'),
      }
      this.emit(`task-${id}` as any, result)
    }
    this.pendingTaskIds.clear()
  }

  /**
   * Transition to a new state, emitting the state-change event.
   */
  protected transition(to: WorkerState): void {
    const from = this.state
    this.state = to
    this.logger.trace({ from, to }, 'Worker state transition')
    this.emit('state-change', from, to)
  }

  /**
   * Assert that the current state is one of the allowed states.
   */
  protected assertState(...allowed: WorkerState[]): void {
    if (!allowed.includes(this.state)) {
      throw new Error(
        `Invalid worker state: ${this.state}, expected one of: ${allowed.join(', ')}`,
      )
    }
  }
}

/**
 * Create a WorkerThreadError from a message.
 */
function createWorkerThreadError(
  message: ThreadErrorMessage,
  includeStack = true,
): WorkerThreadError {
  const error = new Error(message.message) as WorkerThreadError
  if (message.name) error.name = message.name
  if (includeStack && message.stack) {
    error.stack = message.stack
  }
  error.origin = message.origin
  error.fatal = message.fatal
  return error
}
