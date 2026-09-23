import { Worker } from 'node:worker_threads'

import { createFuture } from '@nmtjs/common'

import type {
  NoParams,
  RpcCommandMap,
  RpcMessage,
  RpcRequestOptions,
} from '../rpc.ts'
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STOP_TIMEOUT_MS,
  OperationScope,
} from '../host/lifecycle.ts'
import { isRpcEvent, RpcChannel } from '../rpc.ts'
import { raceWithTimeout } from '../utils.ts'

// Every service stops through its own `stop` command before it exits.
export type WorkerServiceCommands = RpcCommandMap & {
  stop: { params: NoParams; result: void }
}

export type WorkerServiceClientOptions<TEvent> = {
  entry: URL
  serviceName: string
  onEvent?: (event: TEvent) => void
  onFailure?: (error: Error) => void
  onStopProgress?: (event: WorkerServiceStopProgressEvent) => void
}

export type WorkerServiceStopProgressEvent =
  | {
      phase: 'slow'
      serviceName: string
      entry: string
      elapsedMs: number
      timeoutMs: number
    }
  | {
      phase: 'timeout'
      serviceName: string
      entry: string
      timeoutMs: number
    }
  | {
      phase: 'complete'
      serviceName: string
      entry: string
      elapsedMs: number
      exited: boolean
    }

const STOP_SLOW_MS = 1_000

export class WorkerServiceClient<
  TCommands extends WorkerServiceCommands,
  TEvent,
> {
  private readonly worker: Worker
  private stopping = false
  private hasExited = false
  private readonly rpc: RpcChannel<TCommands>
  private readonly exited = createFuture<void>()

  constructor(private readonly options: WorkerServiceClientOptions<TEvent>) {
    this.worker = new Worker(options.entry)
    this.rpc = new RpcChannel({
      post: (message) => this.worker.postMessage(message),
      timeoutMs: getRequestTimeoutMs,
      timeoutMessage: (type, timeoutMs) =>
        `Neem worker service request [${options.serviceName}:${type}] timed out after ${timeoutMs}ms`,
    })
    this.worker.on('message', (message) => this.handleMessage(message))
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.handleExit(code))
  }

  request<K extends keyof TCommands & string>(
    type: K,
    params: TCommands[K]['params'],
    options: Pick<RpcRequestOptions, 'timeoutMs'> = {},
  ): Promise<TCommands[K]['result']> {
    if (this.hasExited) {
      return Promise.reject(
        new Error(
          `Neem worker service [${this.options.serviceName}] is not running`,
        ),
      )
    }
    return this.rpc.request(type, params, options)
  }

  /**
   * Stops the service within the scope's deadline; a service that misses it is
   * terminated and the stop rejects.
   */
  async stop(
    scope: OperationScope = OperationScope.withTimeout(DEFAULT_STOP_TIMEOUT_MS),
  ): Promise<void> {
    this.stopping = true
    const startedAt = Date.now()
    const budget = scope.remaining()
    let slow = false
    const slowTimer = setTimeout(() => {
      slow = true
      this.reportStopProgress({
        phase: 'slow',
        elapsedMs: STOP_SLOW_MS,
        timeoutMs: budget,
      })
    }, STOP_SLOW_MS)
    slowTimer.unref()
    let exited = false
    try {
      // Every service map declares `stop` with no params (WorkerServiceCommands).
      await this.request('stop', {} as TCommands['stop']['params'], {
        timeoutMs: Math.min(getRequestTimeoutMs(), scope.remaining()),
      }).catch((error) => {
        // The service may exit before answering its own stop request.
        if (this.worker.threadId !== -1) throw error
      })
      const result = await raceWithTimeout(
        this.exited.promise,
        scope.remaining(),
      )
      exited = !result.timedOut
      if (result.timedOut) {
        this.reportStopProgress({ phase: 'timeout', timeoutMs: budget })
      }
    } finally {
      clearTimeout(slowTimer)
      if (slow) {
        this.reportStopProgress({
          phase: 'complete',
          elapsedMs: Date.now() - startedAt,
          exited,
        })
      }
      if (!exited) await this.worker.terminate().catch(() => undefined)
      this.rpc.settleAll(new Error('Neem worker service stopped'))
    }
    if (!exited) {
      throw new Error(
        `Neem worker service [${this.options.serviceName}] did not exit within ${Math.round(budget)}ms and was terminated`,
      )
    }
  }

  private handleMessage(message: RpcMessage<TEvent>): void {
    if (this.rpc.settle(message)) return
    if (isRpcEvent<TEvent>(message)) this.options.onEvent?.(message.event)
  }

  private handleExit(code: number): void {
    this.hasExited = true
    this.exited.resolve()
    this.rpc.settleAll(
      new Error(
        `Neem worker service exited with code [${code}] before responding`,
      ),
    )
    if (this.stopping) return

    this.options.onFailure?.(
      new Error(`Neem worker service exited with code [${code}]`),
    )
  }

  private reportStopProgress(
    event:
      | { phase: 'slow'; elapsedMs: number; timeoutMs: number }
      | { phase: 'timeout'; timeoutMs: number }
      | { phase: 'complete'; elapsedMs: number; exited: boolean },
  ): void {
    this.options.onStopProgress?.({
      ...event,
      serviceName: this.options.serviceName,
      entry: this.options.entry.href,
    })
  }

  private fail(error: Error): void {
    this.rpc.settleAll(error)
    this.options.onFailure?.(error)
  }
}

export function resolveServiceEntry(name: string): URL {
  return new URL(`./${name}.js`, import.meta.url)
}

function getRequestTimeoutMs(): number {
  const value = Number.parseInt(
    process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS ?? '',
    10,
  )
  return Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_REQUEST_TIMEOUT_MS
}
