import type { Logger } from '@nmtjs/core'

import type { ServerLifecycle } from './lifecycle.ts'

/**
 * HMRCoordinator handles HMR (Hot Module Replacement) with proper supersede logic.
 *
 * When a reload is in progress and another HMR event arrives, the pending reload
 * is superseded by the latest - only the most recent config is applied.
 *
 * This component is only used in development mode.
 */
export class HMRCoordinator {
  /** Currently executing reload, if any */
  private active: Promise<void> | null = null

  /** Pending reload - only the latest request is kept */
  private pendingResolvers: {
    resolve: () => void
    reject: (e: Error) => void
  } | null = null

  /** Whether a reload is pending after the current one completes */
  private hasPending = false

  private logger: Logger

  constructor(
    private readonly lifecycle: ServerLifecycle,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: 'HMRCoordinator' })
  }

  /**
   * Schedule a reload. If a reload is already in progress, supersedes any pending reload.
   *
   * @returns Promise that resolves when this reload completes (or is superseded)
   */
  async scheduleReload(): Promise<void> {
    // If no active reload, execute immediately
    if (!this.active) {
      return this.executeReload()
    }

    // Supersede any existing pending reload - resolve previous waiter
    if (this.pendingResolvers) {
      this.logger.debug('Superseding pending reload with new request')
      this.pendingResolvers.resolve()
    }

    // Mark that we have a pending reload
    this.hasPending = true

    // Create new pending promise for this caller
    return new Promise((resolve, reject) => {
      this.pendingResolvers = { resolve, reject }
    })
  }

  /**
   * Execute a reload, handling the pending queue.
   */
  private async executeReload(): Promise<void> {
    this.logger.debug('HMR reload starting')

    this.active = this.doReload()

    try {
      await this.active
      this.logger.debug('HMR reload complete')
    } finally {
      this.active = null

      // If there's a pending reload, execute it now
      if (this.hasPending && this.pendingResolvers) {
        const { resolve, reject } = this.pendingResolvers
        this.pendingResolvers = null
        this.hasPending = false
        this.executeReload().then(resolve, reject)
      }
    }
  }

  /**
   * Perform the actual reload via the lifecycle.
   */
  private async doReload(): Promise<void> {
    // Check if lifecycle can reload
    if (this.lifecycle.canReload) {
      await this.lifecycle.reload()
    } else if (this.lifecycle.canStart) {
      // If in failed/idle state, try to start
      await this.lifecycle.start()
    } else {
      this.logger.warn(
        { state: this.lifecycle.currentState },
        'Cannot reload in current state',
      )
    }
  }

  /**
   * Check if a reload is currently in progress.
   */
  get isReloading(): boolean {
    return this.active !== null
  }

  /**
   * Check if there's a pending reload waiting.
   */
  get isPending(): boolean {
    return this.hasPending
  }
}
