import { Worker } from 'node:worker_threads'

import { createFuture } from '@nmtjs/common'

import type { RpcCommand } from '../rpc.ts'
import type { SerializedError } from '../utils.ts'
import { RpcChannel } from '../rpc.ts'
import { raceWithTimeout } from '../utils.ts'

export type WorkerServiceResponse<TEvent, TResult> =
  | { id: number; type: 'result'; data?: TResult }
  | { id: number; type: 'error'; error: SerializedError }
  | { type: 'event'; event: TEvent }

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

const STOP_TIMEOUT_MS = 5_000
const STOP_SLOW_MS = 1_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class WorkerServiceClient<TEvent, TResult = unknown> {
  private readonly worker: Worker
  private stopping = false
  private hasExited = false
  private readonly rpc: RpcChannel<TResult>
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

  request<T extends TResult = TResult>(
    command: RpcCommand,
    options: { timeoutMs?: number } = {},
  ): Promise<T | undefined> {
    if (this.hasExited) {
      return Promise.reject(
        new Error(
          `Neem worker service [${this.options.serviceName}] is not running`,
        ),
      )
    }
    return this.rpc.request(command, options) as Promise<T | undefined>
  }

  async stop(command: { type: 'stop' } = { type: 'stop' }): Promise<void> {
    this.stopping = true
    const startedAt = Date.now()
    let slow = false
    const slowTimer = setTimeout(() => {
      slow = true
      this.reportStopProgress({
        phase: 'slow',
        elapsedMs: STOP_SLOW_MS,
        timeoutMs: STOP_TIMEOUT_MS,
      })
    }, STOP_SLOW_MS)
    slowTimer.unref()
    let exited = false
    try {
      await this.request(command, { timeoutMs: STOP_TIMEOUT_MS }).catch(
        (error) => {
          if (this.worker.threadId !== -1) throw error
        },
      )
      const result = await raceWithTimeout(this.exited.promise, STOP_TIMEOUT_MS)
      exited = !result.timedOut
      if (result.timedOut) {
        this.reportStopProgress({
          phase: 'timeout',
          timeoutMs: STOP_TIMEOUT_MS,
        })
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
  }

  private handleMessage(message: WorkerServiceResponse<TEvent, TResult>): void {
    if (message.type === 'event') {
      this.options.onEvent?.(message.event)
      return
    }

    this.rpc.settle(message)
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
