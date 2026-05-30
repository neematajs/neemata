import { Worker } from 'node:worker_threads'

import { createFuture } from '@nmtjs/common'

import type { SerializedError } from '../shared/utils.ts'
import { deserializeError, wait } from '../shared/utils.ts'

export type WorkerServiceResponse<TEvent, TResult> =
  | { id: number; type: 'result'; data?: TResult }
  | { id: number; type: 'error'; error: SerializedError }
  | { type: 'event'; event: TEvent }

export type WorkerServiceClientOptions<TEvent> = {
  entry: URL
  onEvent?: (event: TEvent) => void
  onFailure?: (error: Error) => void
}

const STOP_TIMEOUT_MS = 5_000

export class WorkerServiceClient<TEvent, TResult = unknown> {
  private readonly worker: Worker
  private nextId = 1
  private stopping = false
  private readonly pending = new Map<
    number,
    ReturnType<typeof createFuture<TResult | undefined>>
  >()
  private readonly exited = createFuture<void>()

  constructor(private readonly options: WorkerServiceClientOptions<TEvent>) {
    this.worker = new Worker(options.entry)
    this.worker.on('message', (message) => this.handleMessage(message))
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.handleExit(code))
  }

  request<T extends TResult = TResult>(
    request: { id: number; type: string } & Record<string, unknown>,
  ): Promise<T | undefined> {
    const id = this.nextId++
    const message = { ...request, id }
    const future = createFuture<TResult | undefined>()
    this.pending.set(id, future)
    this.worker.postMessage(message)
    return future.promise as Promise<T | undefined>
  }

  async stop(
    request: { id: number; type: 'stop' } = { id: 0, type: 'stop' },
  ): Promise<void> {
    this.stopping = true
    let exited = false
    try {
      await this.request(request).catch((error) => {
        if (this.worker.threadId !== -1) throw error
      })
      await Promise.race([
        this.exited.promise.then(() => {
          exited = true
        }),
        wait(STOP_TIMEOUT_MS),
      ])
    } finally {
      if (!exited) await this.worker.terminate().catch(() => undefined)
      this.rejectPending(new Error('Neem worker service stopped'))
    }
  }

  private handleMessage(message: WorkerServiceResponse<TEvent, TResult>): void {
    if (message.type === 'event') {
      this.options.onEvent?.(message.event)
      return
    }

    const future = this.pending.get(message.id)
    if (!future) return
    this.pending.delete(message.id)

    if (message.type === 'error') {
      future.reject(deserializeError(message.error))
    } else {
      future.resolve(message.data)
    }
  }

  private handleExit(code: number): void {
    this.exited.resolve()
    if (this.stopping) return

    this.fail(new Error(`Neem worker service exited with code [${code}]`))
  }

  private fail(error: Error): void {
    this.rejectPending(error)
    this.options.onFailure?.(error)
  }

  private rejectPending(error: Error): void {
    for (const future of this.pending.values()) future.reject(error)
    this.pending.clear()
  }
}

export function resolveServiceEntry(name: string): URL {
  return new URL(`./${name}.js`, import.meta.url)
}
