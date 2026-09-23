import { Worker } from 'node:worker_threads'

import type { MaybePromise } from '@nmtjs/common'
import { createFuture } from '@nmtjs/common'

import type {
  NeemRuntimePlan,
  NeemRuntimeThreadHandle,
} from '../../shared/types.ts'
import type { OperationScope } from './lifecycle.ts'
import type {
  HostRunnerCommand,
  HostRunnerData,
  HostRunnerResponse,
  HostRunnerResult,
} from './runner-protocol.ts'
import { RpcChannel } from '../rpc.ts'
import { deserializeError, raceWithTimeout } from '../utils.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './lifecycle.ts'
import { getTransferList } from './runner-protocol.ts'

export type HostRunnerOptions = {
  data: HostRunnerData
  env: NodeJS.ProcessEnv
  // Reports only; the owning RuntimeController decides what a failure means.
  onFailure?: (error: Error) => MaybePromise<void>
}

// Only an exit or error while running is a failure; one during a requested
// shutdown is the shutdown itself.
type HostRunnerState = 'idle' | 'running' | 'shutting-down' | 'failed'

export class HostRunner {
  private worker: Worker | undefined
  private state: HostRunnerState = 'idle'
  private readonly rpc: RpcChannel<HostRunnerResult>
  private ready: ReturnType<typeof createFuture<void>> | undefined
  private exited: ReturnType<typeof createFuture<void>> | undefined

  constructor(private readonly options: HostRunnerOptions) {
    this.rpc = new RpcChannel({
      post: (message, transfer) => this.worker?.postMessage(message, transfer),
      timeoutMs: () => this.requestTimeoutMs(),
      timeoutMessage: (type, timeoutMs) =>
        `Neem host runner request [${type}] timed out after ${timeoutMs}ms`,
    })
  }

  async start(): Promise<void> {
    if (this.worker) return

    this.state = 'running'
    this.ready = createFuture<void>()
    this.exited = createFuture<void>()
    const worker = new Worker(resolveHostRunnerEntry(), {
      workerData: this.options.data,
      env: this.options.env,
    })
    this.worker = worker
    worker.on('message', (message) => this.handleMessage(message))
    worker.on('error', (error) => this.handleFailure(error))
    worker.on('exit', (code) => this.handleExit(code))
    await this.ready.promise
  }

  async plan(): Promise<NeemRuntimePlan | undefined> {
    const result = await this.request({ type: 'plan' })
    return result?.plan
  }

  async callStart(threads: readonly NeemRuntimeThreadHandle[]): Promise<void> {
    await this.request({ type: 'start', threads })
  }

  // Bounded by both the request timeout and what is left of the stop budget.
  async callStop(scope: OperationScope): Promise<void> {
    if (this.state !== 'running') return
    await this.request(
      { type: 'stop' },
      Math.min(this.requestTimeoutMs(), scope.remaining()),
    )
  }

  /** Rejects when the runner had to be terminated at the scope's deadline. */
  async shutdown(scope: OperationScope): Promise<void> {
    const worker = this.worker
    const exited = this.exited
    if (!worker || !exited) return

    if (this.state === 'running') {
      this.state = 'shutting-down'
      // The exit acknowledges the shutdown; the reply only races it.
      this.request(
        { type: 'shutdown' },
        Math.min(this.requestTimeoutMs(), scope.remaining()),
      ).catch(() => undefined)
    }
    const budget = scope.remaining()
    const exit = await raceWithTimeout(exited.promise, budget)
    this.worker = undefined
    this.rpc.settleAll(new Error('Neem host runner stopped'))
    if (!exit.timedOut) return

    await worker.terminate().catch(() => undefined)
    throw new Error(
      `Neem host runner did not exit within ${Math.round(budget)}ms and was terminated`,
    )
  }

  private request(
    command: HostRunnerCommand,
    timeoutMs?: number,
  ): Promise<HostRunnerResult | undefined> {
    if (!this.worker || this.state === 'failed') {
      throw new Error('Neem host runner is not running')
    }
    return this.rpc.request(command, {
      timeoutMs,
      transfer: getTransferList(command),
    })
  }

  private handleMessage(message: HostRunnerResponse): void {
    if (message.type === 'ready') {
      this.ready?.resolve()
      this.ready = undefined
      return
    }

    if (message.type === 'failure') {
      this.handleFailure(deserializeError(message.error))
      return
    }

    this.rpc.settle(message)
  }

  private handleExit(code: number): void {
    this.exited?.resolve()
    this.ready?.reject(new Error(`Neem host runner exited with code [${code}]`))
    this.worker = undefined
    this.rpc.settleAll(
      new Error(
        `Neem host runner exited with code [${code}] before responding`,
      ),
    )
    this.handleFailure(new Error(`Neem host runner exited with code [${code}]`))
  }

  private handleFailure(error: Error): void {
    if (this.state !== 'running') return
    this.state = 'failed'
    this.ready?.reject(error)
    this.rpc.settleAll(error)
    void this.options.onFailure?.(error)
  }

  private requestTimeoutMs(): number {
    const value = Number.parseInt(
      this.options.env.NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS ?? '',
      10,
    )
    return Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_REQUEST_TIMEOUT_MS
  }
}

function resolveHostRunnerEntry(): URL {
  return new URL('./runner-entry.js', import.meta.url)
}
