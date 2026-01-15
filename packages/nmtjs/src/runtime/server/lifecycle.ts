import EventEmitter from 'node:events'

import type { Logger } from '@nmtjs/core'

import type { RuntimeEnvironment } from './environment.ts'
import type { ApplicationServer } from './server.ts'

/**
 * States in the server lifecycle state machine.
 */
export type LifecycleState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'reloading'
  | 'stopping'
  | 'stopped'
  | 'failed'

/**
 * Events emitted by the ServerLifecycle.
 */
export interface LifecycleEvents {
  'state-change': [from: LifecycleState, to: LifecycleState]
  error: [error: Error, handled: boolean]
}

/**
 * Factory function type for creating ApplicationServer instances.
 */
export type ServerFactory = () => ApplicationServer | Promise<ApplicationServer>

/**
 * ServerLifecycle manages the application server lifecycle with a clean state machine.
 *
 * States:
 * - idle: Initial state, server not started
 * - starting: Server is being started
 * - running: Server is running normally
 * - reloading: Server is being reloaded (stop + start)
 * - stopping: Server is being stopped
 * - stopped: Server has been stopped (terminal state)
 * - failed: Server failed to start (can recover via reload in dev mode)
 *
 * Transitions:
 * - idle -> starting (via start())
 * - starting -> running (success) | failed (error)
 * - running -> reloading (via reload()) | stopping (via stop())
 * - reloading -> running (success) | failed (error)
 * - failed -> reloading (via reload()) | stopping (via stop())
 * - stopping -> stopped
 */
export class ServerLifecycle extends EventEmitter<LifecycleEvents> {
  private state: LifecycleState = 'idle'
  private server: ApplicationServer | null = null
  private logger: Logger

  constructor(
    private readonly env: RuntimeEnvironment,
    private readonly createServer: ServerFactory,
    logger: Logger,
  ) {
    super()
    this.logger = logger.child({ component: 'ServerLifecycle' })
  }

  /** Current lifecycle state */
  get currentState(): LifecycleState {
    return this.state
  }

  /** Whether the server is currently running */
  get isRunning(): boolean {
    return this.state === 'running'
  }

  /** Whether the server can be started */
  get canStart(): boolean {
    return this.state === 'idle' || this.state === 'failed'
  }

  /** Whether the server can be stopped */
  get canStop(): boolean {
    return (
      this.state === 'running' ||
      this.state === 'failed' ||
      this.state === 'reloading'
    )
  }

  /** Whether the server can be reloaded */
  get canReload(): boolean {
    return this.state === 'running' || this.state === 'failed'
  }

  /** Get the current server instance (if running) */
  getServer(): ApplicationServer | null {
    return this.server
  }

  /**
   * Start the server.
   * Can only be called from 'idle' or 'failed' states.
   */
  async start(): Promise<void> {
    this.assertState('idle', 'failed')
    this.transition('starting')

    try {
      this.server = await this.createServer()
      await this.server.start()
      this.transition('running')
    } catch (error) {
      this.transition('failed')
      await this.handleStartupError(error as Error)
    }
  }

  /**
   * Stop the server.
   * Can be called from 'running', 'failed', or 'reloading' states.
   * No-op if already stopped or idle.
   */
  async stop(): Promise<void> {
    if (this.state === 'stopped' || this.state === 'idle') return
    this.assertState('running', 'failed', 'reloading')

    this.transition('stopping')
    try {
      await this.server?.stop()
    } catch (error) {
      this.logger.error(
        new Error('Error while stopping server (continuing shutdown)', {
          cause: error,
        }),
      )
    } finally {
      this.server = null
      this.transition('stopped')
    }
  }

  /**
   * Reload the server (stop current instance and start a new one).
   * Can be called from 'running' or 'failed' states.
   */
  async reload(): Promise<void> {
    this.assertState('running', 'failed')
    this.transition('reloading')

    try {
      // Stop current server if exists
      if (this.server) {
        await this.server.stop()
        this.server = null
      }

      // Create and start new server
      this.server = await this.createServer()
      await this.server.start()
      this.transition('running')
    } catch (error) {
      this.server = null
      this.transition('failed')
      await this.handleStartupError(error as Error)
    }
  }

  /**
   * Handle startup/reload error according to the error policy.
   */
  private async handleStartupError(error: Error): Promise<void> {
    const action = this.env.errorPolicy.onStartupError(error)
    const handled = action.type !== 'exit'

    this.emit('error', error, handled)

    switch (action.type) {
      case 'exit':
        this.logger.fatal(
          new Error('Startup failed, exiting', { cause: error }),
        )
        process.exit(action.code)
        break
      case 'wait':
        // Dev mode: stay alive, HMR will call reload()
        this.logger.error(
          new Error('Startup failed, waiting for fix via HMR', {
            cause: error,
          }),
        )
        break
      case 'restart':
        this.logger.warn(
          { error, delay: action.delay },
          'Startup failed, scheduling restart',
        )
        setTimeout(() => {
          // Only restart if still in failed state
          if (this.state === 'failed') {
            this.start().catch((e) => {
              this.logger.error(new Error('Restart failed', { cause: e }))
            })
          }
        }, action.delay)
        break
      case 'ignore':
        this.logger.warn({ error }, 'Startup failed, ignoring')
        break
    }
  }

  /**
   * Transition to a new state, emitting the state-change event.
   */
  private transition(to: LifecycleState): void {
    const from = this.state
    this.state = to
    this.logger.debug({ from, to }, 'State transition')
    this.emit('state-change', from, to)
  }

  /**
   * Assert that the current state is one of the allowed states.
   * Throws if not.
   */
  private assertState(...allowed: LifecycleState[]): void {
    if (!allowed.includes(this.state)) {
      throw new Error(
        `Invalid state: ${this.state}, expected one of: ${allowed.join(', ')}`,
      )
    }
  }
}
