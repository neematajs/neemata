import { Worker } from 'node:worker_threads'

import { createFuture } from '@nmtjs/common'

import type { RpcCommand } from '../rpc.ts'
import type { ServiceResponse } from './protocol.ts'
import { RpcChannel } from '../rpc.ts'
import { getRequestTimeoutMs, STOP_TIMEOUT_MS } from '../threads.ts'
import { raceWithTimeout } from '../utils.ts'

export type WorkerServiceClientOptions<TEvent> = {
  entry: URL
  serviceName: string
  onEvent?: (event: TEvent) => void
  onFailure?: (error: Error) => void
  onStopProgress?: (event: WorkerServiceStopProgressEvent) => void
}

type StopPhase =
  | { phase: 'slow'; elapsedMs: number; timeoutMs: number }
  | { phase: 'timeout'; timeoutMs: number }
  | { phase: 'complete'; elapsedMs: number; exited: boolean }

export type WorkerServiceStopProgressEvent = StopPhase & {
  serviceName: string
  entry: string
}

const STOP_SLOW_MS = 1_000

export class WorkerServiceClient<
  TCommand extends RpcCommand,
  TEvent,
  TResult = unknown,
> {
  private readonly worker: Worker
  private stopping = false
  private hasExited = false
  private readonly rpc: RpcChannel<TResult>
  private readonly exited = createFuture<void>()

  constructor(private readonly options: WorkerServiceClientOptions<TEvent>) {
    this.worker = new Worker(options.entry)
    this.rpc = new RpcChannel({
      post: (message) => this.worker.postMessage(message),
      timeoutMs: () =>
        getRequestTimeoutMs(process.env.NEEM_WORKER_SERVICE_REQUEST_TIMEOUT_MS),
      timeoutMessage: (type, timeoutMs) =>
        `Neem worker service request [${options.serviceName}:${type}] timed out after ${timeoutMs}ms`,
    })
    this.worker.on('message', (message) => this.handleMessage(message))
    this.worker.on('error', (error) => this.fail(error))
    this.worker.on('exit', (code) => this.handleExit(code))
  }

  request(
    command: TCommand,
    options: { timeoutMs?: number } = {},
  ): Promise<TResult | undefined> {
    return this.send(command, options)
  }

  async stop(): Promise<void> {
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
      await this.send({ type: 'stop' }, { timeoutMs: STOP_TIMEOUT_MS }).catch(
        (error) => {
          if (!this.hasExited) throw error
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

  private send(
    command: RpcCommand,
    options: { timeoutMs?: number },
  ): Promise<TResult | undefined> {
    if (this.hasExited) {
      return Promise.reject(
        new Error(
          `Neem worker service [${this.options.serviceName}] is not running`,
        ),
      )
    }
    return this.rpc.request(command, options)
  }

  private handleMessage(message: ServiceResponse<TEvent, TResult>): void {
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

  private reportStopProgress(event: StopPhase): void {
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
