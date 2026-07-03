import { Worker } from 'node:worker_threads'

import type { MaybePromise } from '@nmtjs/common'
import { createFuture } from '@nmtjs/common'

import type {
  NeemRuntimePlan,
  NeemRuntimeThreadHandle,
} from '../../shared/types.ts'
import type {
  HostRunnerCommand,
  HostRunnerData,
  HostRunnerResponse,
  HostRunnerResult,
} from './runner-protocol.ts'
import { RpcChannel } from '../rpc.ts'
import { deserializeError, raceWithTimeout } from '../utils.ts'
import { getTransferList } from './runner-protocol.ts'

export type HostRunnerOptions = {
  data: HostRunnerData
  env: NodeJS.ProcessEnv
  onFailure?: (error: Error) => MaybePromise<void>
}

const STOP_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class HostRunner {
  private worker: Worker | undefined
  private readonly rpc: RpcChannel<HostRunnerResult>
  private ready: ReturnType<typeof createFuture<void>> | undefined
  private exited: ReturnType<typeof createFuture<void>> | undefined
  private stopping = false
  private failed = false

  constructor(private readonly options: HostRunnerOptions) {
    this.rpc = new RpcChannel({
      post: (message, transfer) => this.worker?.postMessage(message, transfer),
      timeoutMs: () => getRequestTimeoutMs(this.options.env),
      timeoutMessage: (type, timeoutMs) =>
        `Neem host runner request [${type}] timed out after ${timeoutMs}ms`,
    })
  }

  async start(): Promise<void> {
    if (this.worker) return

    this.stopping = false
    this.failed = false
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

  async callStop(): Promise<void> {
    if (!this.worker) return
    await this.request({ type: 'stop' })
  }

  async shutdown(): Promise<void> {
    const worker = this.worker
    if (!worker) return

    this.stopping = true
    let exited = false
    try {
      await this.request({ type: 'shutdown' })
      if (this.exited) {
        const result = await raceWithTimeout(
          this.exited.promise,
          STOP_TIMEOUT_MS,
        )
        exited = !result.timedOut
      }
    } finally {
      if (!exited) await worker.terminate().catch(() => undefined)
      this.worker = undefined
      this.rpc.settleAll(new Error('Neem host runner stopped'))
    }
  }

  private request(
    command: HostRunnerCommand,
  ): Promise<HostRunnerResult | undefined> {
    if (!this.worker) throw new Error('Neem host runner is not started')
    return this.rpc.request(command, { transfer: getTransferList(command) })
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

    if (!this.stopping) {
      this.handleFailure(
        new Error(`Neem host runner exited with code [${code}]`),
      )
    }
  }

  private handleFailure(error: Error): void {
    if (this.failed) return
    this.failed = true
    this.worker = undefined
    this.ready?.reject(error)
    this.rpc.settleAll(error)
    void this.options.onFailure?.(error)
  }
}

function resolveHostRunnerEntry(): URL {
  return new URL('./runner-entry.js', import.meta.url)
}

function getRequestTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = Number.parseInt(
    env.NEEM_HOST_RUNNER_REQUEST_TIMEOUT_MS ?? '',
    10,
  )
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_REQUEST_TIMEOUT_MS
}
