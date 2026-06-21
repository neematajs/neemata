import { Worker } from 'node:worker_threads'

import type { MaybePromise } from '@nmtjs/common'
import { createFuture } from '@nmtjs/common'

import type {
  NeemRuntimePlan,
  NeemRuntimeThreadHandle,
} from '../../shared/types.ts'
import type {
  HostRunnerData,
  HostRunnerRequest,
  HostRunnerResponse,
  HostRunnerResult,
} from './runner-protocol.ts'
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
  private nextId = 1
  private readonly pending = new Map<
    number,
    {
      future: ReturnType<typeof createFuture<HostRunnerResult | undefined>>
      timeout: NodeJS.Timeout
    }
  >()
  private ready: ReturnType<typeof createFuture<void>> | undefined
  private exited: ReturnType<typeof createFuture<void>> | undefined
  private stopping = false
  private failed = false

  constructor(private readonly options: HostRunnerOptions) {}

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
    const result = await this.request({ id: 0, type: 'plan' })
    return result?.plan
  }

  async callStart(threads: readonly NeemRuntimeThreadHandle[]): Promise<void> {
    await this.request({ id: 0, type: 'start', threads })
  }

  async callStop(): Promise<void> {
    if (!this.worker) return
    await this.request({ id: 0, type: 'stop' })
  }

  async shutdown(): Promise<void> {
    const worker = this.worker
    if (!worker) return

    this.stopping = true
    let exited = false
    try {
      await this.request({ id: 0, type: 'shutdown' })
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
      this.rejectPending(new Error('Neem host runner stopped'))
    }
  }

  private request(
    request: HostRunnerRequest,
  ): Promise<HostRunnerResult | undefined> {
    const worker = this.worker
    if (!worker) throw new Error('Neem host runner is not started')

    const id = this.nextId++
    const message = { ...request, id } as HostRunnerRequest
    const future = createFuture<HostRunnerResult | undefined>()
    const timeoutMs = getRequestTimeoutMs(this.options.env)
    const timeout = setTimeout(() => {
      this.pending.delete(id)
      future.reject(
        new Error(
          `Neem host runner request [${request.type}] timed out after ${timeoutMs}ms`,
        ),
      )
    }, timeoutMs)
    timeout.unref()

    this.pending.set(id, { future, timeout })
    worker.postMessage(message, getTransferList(message))
    return future.promise
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

    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    clearTimeout(pending.timeout)

    if (message.type === 'error') {
      pending.future.reject(deserializeError(message.error))
    } else {
      pending.future.resolve(message.data)
    }
  }

  private handleExit(code: number): void {
    this.exited?.resolve()
    this.ready?.reject(new Error(`Neem host runner exited with code [${code}]`))
    this.worker = undefined

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
    this.failPending(error)
    void this.options.onFailure?.(error)
  }

  private failPending(error: Error): void {
    this.ready?.reject(error)
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.future.reject(error)
    }
    this.pending.clear()
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
