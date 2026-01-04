import EventEmitter from 'node:events'

import type { Logger } from '@nmtjs/core'

import type { ErrorPolicy } from './error-policy.ts'
import type {
  ManagedWorkerFactory,
  PoolHealth,
  PoolHealthReport,
  WorkerPool,
  WorkerPoolConfig,
  WorkerPoolFactory,
} from './worker-pool.ts'

/**
 * Overall server health state.
 */
export type ServerHealth = 'healthy' | 'degraded' | 'unhealthy'

/**
 * Report on overall server health including all pools.
 */
export interface ServerHealthReport {
  overall: ServerHealth
  pools: PoolHealthReport[]
}

/**
 * Events emitted by PoolManager.
 */
export interface PoolManagerEvents {
  'health-change': [health: ServerHealth]
  'pool-health-change': [poolName: string, health: PoolHealth]
}

/**
 * PoolManager manages multiple application pools with aggregate health tracking.
 *
 * Features:
 * - Creates and manages WorkerPools for each application/job type
 * - Aggregates health across all pools
 * - Provides server-level health reports
 *
 * Each application gets its own pool for isolated failure domains.
 * For example, if "api" is degraded but "admin" is healthy, they're tracked independently.
 */
export class PoolManager extends EventEmitter<PoolManagerEvents> {
  private pools = new Map<string, WorkerPool>()
  private health: ServerHealth = 'healthy'
  private logger: Logger

  constructor(
    private readonly policy: ErrorPolicy,
    private readonly workerFactory: ManagedWorkerFactory,
    private readonly poolFactory: WorkerPoolFactory,
    logger: Logger,
  ) {
    super()
    this.logger = logger.child({ component: 'PoolManager' })
  }

  /** Current overall server health */
  get currentHealth(): ServerHealth {
    return this.health
  }

  /** Number of pools managed */
  get poolCount(): number {
    return this.pools.size
  }

  /**
   * Create a new pool for an application or job type.
   *
   * @param config - Pool configuration
   * @returns The created WorkerPool
   * @throws If a pool with this name already exists
   */
  createPool(config: WorkerPoolConfig): WorkerPool {
    if (this.pools.has(config.name)) {
      throw new Error(`Pool for "${config.name}" already exists`)
    }

    const pool = this.poolFactory(
      config,
      this.policy,
      this.workerFactory,
      this.logger,
    )

    pool.on('health-change', (health) => {
      this.emit('pool-health-change', config.name, health)
      this.updateHealth()
    })

    this.pools.set(config.name, pool)
    this.logger.debug({ pool: config.name }, 'Pool created')

    return pool
  }

  /**
   * Get a pool by name.
   */
  getPool(name: string): WorkerPool | undefined {
    return this.pools.get(name)
  }

  /**
   * Get all pools.
   */
  getAllPools(): Map<string, WorkerPool> {
    return new Map(this.pools)
  }

  /**
   * Start all pools.
   */
  async startAll(): Promise<void> {
    this.logger.debug({ count: this.pools.size }, 'Starting all pools')
    await Promise.all([...this.pools.values()].map((p) => p.startAll()))
    this.logger.debug({ count: this.pools.size }, 'All pools started')
  }

  /**
   * Stop all pools.
   */
  async stopAll(): Promise<void> {
    this.logger.debug({ count: this.pools.size }, 'Stopping all pools')
    await Promise.all([...this.pools.values()].map((p) => p.stopAll()))
    this.pools.clear()
    this.logger.debug('All pools stopped')
  }

  /**
   * Get a health report for all pools.
   * This is for internal debugging/logging only.
   * External health checks should use application-level procedures
   * or external monitoring (k8s probes, process monitors).
   */
  getHealthReport(): ServerHealthReport {
    const poolReports = [...this.pools.values()].map((p) => p.getHealthReport())
    return { overall: this.health, pools: poolReports }
  }

  /**
   * Update overall server health based on pool states.
   */
  private updateHealth(): void {
    const poolHealths = [...this.pools.values()].map((p) => p.currentHealth)

    // No pools = healthy
    if (poolHealths.length === 0) {
      this.setHealth('healthy')
      return
    }

    let newHealth: ServerHealth
    if (poolHealths.every((h) => h === 'healthy')) {
      newHealth = 'healthy'
    } else if (
      poolHealths.some((h) => h !== 'unhealthy') &&
      this.policy.allowDegradedMode
    ) {
      newHealth = 'degraded'
    } else {
      newHealth = 'unhealthy'
    }

    this.setHealth(newHealth)
  }

  /**
   * Set the health state, emitting event if changed.
   */
  private setHealth(newHealth: ServerHealth): void {
    if (newHealth !== this.health) {
      const oldHealth = this.health
      this.health = newHealth
      this.logger.info(
        { from: oldHealth, to: newHealth },
        'Server health changed',
      )
      this.emit('health-change', newHealth)
    }
  }
}
