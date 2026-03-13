import EventEmitter from 'node:events'

import type { Logger } from '@nmtjs/core'

import type { WorkerType } from './enums.ts'
import type { ErrorPolicy } from './error-policy.ts'
import type {
  ManagedWorker,
  ManagedWorkerConfig,
  WorkerState,
} from './managed-worker.ts'

/**
 * Health states for a worker pool.
 */
export type PoolHealth = 'healthy' | 'degraded' | 'unhealthy'

/**
 * Report on pool health status.
 */
export interface PoolHealthReport {
  poolName: string
  overall: PoolHealth
  healthy: number
  total: number
  workers: Array<{
    id: string
    state: WorkerState
    consecutiveFailures: number
    totalFailures: number
  }>
}

/**
 * Configuration for creating a worker pool.
 */
export interface WorkerPoolConfig {
  name: string
  workerType: WorkerType
  path: string
  workerData?: any
  onWorker?: (worker: import('node:worker_threads').Worker) => void
}

export interface WorkerPoolAddOptions {
  id?: string
  name?: string
  path?: string
  workerType?: WorkerType
  workerOptions?: ManagedWorkerConfig['workerOptions']
  onWorker?: ManagedWorkerConfig['onWorker']
}

/**
 * Events emitted by WorkerPool.
 */
export interface WorkerPoolEvents {
  'health-change': [health: PoolHealth]
}

/**
 * Factory function for creating ManagedWorker instances.
 * This allows for dependency injection and testing.
 */
export type ManagedWorkerFactory = (
  config: ManagedWorkerConfig,
  policy: ErrorPolicy,
  logger: Logger,
) => ManagedWorker

/**
 * Factory function for creating WorkerPool instances.
 * This allows for dependency injection and testing.
 */
export type WorkerPoolFactory = (
  config: WorkerPoolConfig,
  policy: ErrorPolicy,
  workerFactory: ManagedWorkerFactory,
  logger: Logger,
) => WorkerPool

/**
 * WorkerPool manages a collection of workers for a single application or job pool.
 *
 * Features:
 * - Health tracking with three states: healthy, degraded, unhealthy
 * - Integration with ErrorPolicy for degraded mode decisions
 * - Worker lifecycle management (start, stop)
 * - Health reports for debugging and monitoring
 *
 * Each application gets its own WorkerPool for isolated failure domains.
 */
export class WorkerPool extends EventEmitter<WorkerPoolEvents> {
  private workers: ManagedWorker[] = []
  private workerStateChangeHandlers = new WeakMap<ManagedWorker, () => void>()
  private health: PoolHealth = 'healthy'
  private logger: Logger

  constructor(
    readonly config: WorkerPoolConfig,
    private readonly policy: ErrorPolicy,
    private readonly workerFactory: ManagedWorkerFactory,
    logger: Logger,
  ) {
    super()
    this.logger = logger.child({ component: 'WorkerPool', pool: config.name })
  }

  /** Current pool health */
  get currentHealth(): PoolHealth {
    return this.health
  }

  /** Total number of workers in the pool */
  get workerCount(): number {
    return this.workers.length
  }

  /** Number of healthy (ready) workers */
  get healthyCount(): number {
    return this.workers.filter((w) => w.isHealthy).length
  }

  /** Get all workers in this pool */
  getWorkers(): readonly ManagedWorker[] {
    return this.workers
  }

  /**
   * Add a worker to the pool.
   *
   * @param workerData - Additional data to pass to the worker
   * @param index - Worker index (used for naming)
   * @param options - Optional worker config overrides
   * @returns The created ManagedWorker
   */
  add(
    workerData: any,
    index: number,
    options?: WorkerPoolAddOptions,
  ): ManagedWorker {
    const { config } = this

    const workerConfig: ManagedWorkerConfig = {
      id: options?.id ?? `${config.name}-${index + 1}`,
      name: options?.name ?? config.name,
      index,
      workerType: options?.workerType ?? config.workerType,
      path: options?.path ?? config.path,
      workerData: { ...config.workerData, ...workerData },
      workerOptions: options?.workerOptions,
      onWorker: options?.onWorker ?? config.onWorker,
    }

    const worker = this.workerFactory(workerConfig, this.policy, this.logger)

    const onStateChange = () => this.updateHealth()
    worker.on('state-change', onStateChange)
    this.workerStateChangeHandlers.set(worker, onStateChange)

    this.workers.push(worker)
    this.updateHealth()
    return worker
  }

  /**
   * Stop and remove a worker by id.
   */
  async remove(workerId: string): Promise<boolean> {
    const workerIndex = this.workers.findIndex((w) => w.config.id === workerId)
    if (workerIndex === -1) return false

    const worker = this.workers[workerIndex]!
    const onStateChange = this.workerStateChangeHandlers.get(worker)
    if (onStateChange) {
      worker.off('state-change', onStateChange)
      this.workerStateChangeHandlers.delete(worker)
    }

    this.workers.splice(workerIndex, 1)
    await worker.stop()
    this.updateHealth()
    return true
  }

  /**
   * Start all workers in the pool.
   */
  async startAll(): Promise<void> {
    this.logger.debug({ count: this.workers.length }, 'Starting all workers')
    await Promise.all(this.workers.map((w) => w.start()))
    this.logger.debug({ count: this.workers.length }, 'All workers started')
  }

  /**
   * Restart workers that are in error state.
   * Called when HMR update comes in and there are failed workers.
   * @returns Number of workers that were restarted
   */
  async restartFailedWorkers(): Promise<number> {
    const failedWorkers = this.workers.filter((w) => w.currentState === 'error')
    if (failedWorkers.length === 0) return 0

    this.logger.debug(
      { count: failedWorkers.length },
      'Restarting failed workers after HMR update',
    )

    // Reset failure counts before restarting
    for (const worker of failedWorkers) {
      worker.resetFailureCount()
    }

    await Promise.all(failedWorkers.map((w) => w.start()))
    return failedWorkers.length
  }

  /**
   * Stop all workers in the pool and clean up.
   */
  async stopAll(): Promise<void> {
    this.logger.debug({ count: this.workers.length }, 'Stopping all workers')

    // Remove all event listeners from workers before stopping
    for (const worker of this.workers) {
      this.workerStateChangeHandlers.delete(worker)
      worker.removeAllListeners()
    }

    await Promise.all(this.workers.map((w) => w.stop()))

    // Clear workers array
    this.workers = []

    // Remove all listeners from the pool itself
    this.removeAllListeners()

    this.logger.debug('All workers stopped and cleaned up')
  }

  /**
   * Get a health report for this pool.
   */
  getHealthReport(): PoolHealthReport {
    return {
      poolName: this.config.name,
      overall: this.health,
      healthy: this.healthyCount,
      total: this.workerCount,
      workers: this.workers.map((w) => ({
        id: w.config.id,
        state: w.currentState,
        consecutiveFailures: w.context.consecutiveFailures,
        totalFailures: w.context.totalFailures,
      })),
    }
  }

  /**
   * Update pool health based on worker states.
   */
  private updateHealth(): void {
    const readyCount = this.healthyCount
    const total = this.workerCount

    let newHealth: PoolHealth
    if (readyCount === total) {
      newHealth = 'healthy'
    } else if (readyCount > 0 && this.policy.allowDegradedMode) {
      newHealth = 'degraded'
    } else {
      newHealth = 'unhealthy'
    }

    if (newHealth !== this.health) {
      const oldHealth = this.health
      this.health = newHealth
      this.logger.trace(
        { from: oldHealth, to: newHealth, ready: readyCount, total },
        'Pool health changed',
      )
      this.emit('health-change', newHealth)
    }
  }
}
