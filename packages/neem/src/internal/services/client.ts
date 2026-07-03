import { Worker } from 'node:worker_threads'

import { createFuture } from '@nmtjs/common'

import type { SerializedError } from '../utils.ts'
import { deserializeError, raceWithTimeout } from '../utils.ts'

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
  private nextId = 1
  private stopping = false
  private readonly pending = new Map<
    number,
    {
      future: ReturnType<typeof createFuture<TResult | undefined>>
      timeout: NodeJS.Timeout
    }
  >()
  private readonly exited = createFuture<void>()

  constructor(private readonly options: WorkerServiceClientOptions<TEvent>) {
    this.worker = new Worker(options.entry)
    this.worker.on('message', (message) => this.handleMessage(message))
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.handleExit(code))
  }

  request<T extends TResult = TResult>(
    command: { type: string } & Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<T | undefined> {
    const id = this.nextId++
    const message = { ...command, id }
    const future = createFuture<TResult | undefined>()
    const timeoutMs = options.timeoutMs ?? getRequestTimeoutMs()
    const timeout = setTimeout(() => {
      this.pending.delete(id)
      future.reject(
        new Error(
          `Neem worker service request [${this.options.serviceName}:${command.type}] timed out after ${timeoutMs}ms`,
        ),
      )
    }, timeoutMs)
    timeout.unref()

    this.pending.set(id, { future, timeout })
    this.worker.postMessage(message)
    return future.promise as Promise<T | undefined>
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
      this.rejectPending(new Error('Neem worker service stopped'))
    }
  }

  private handleMessage(message: WorkerServiceResponse<TEvent, TResult>): void {
    if (message.type === 'event') {
      this.options.onEvent?.(message.event)
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
    this.exited.resolve()
    if (this.stopping) return

    this.fail(new Error(`Neem worker service exited with code [${code}]`))
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
    this.rejectPending(error)
    this.options.onFailure?.(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout)
      pending.future.reject(error)
    }
    this.pending.clear()
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
