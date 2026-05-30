import { OperationQueue, OperationSupersededError } from '@nmtjs/common'
import { debounce } from 'perfect-debounce'

export type NeemDevReloadRequest =
  | { type: 'full' }
  | { type: 'runtimes'; runtimeNames: string[] }

export type NeemDevReloadSchedulerOptions = {
  debounceMs: number
  isStopped: () => boolean
  onBegin: () => void
  onFlush: (request: NeemDevReloadRequest) => Promise<void>
  onError: (error: unknown) => void
}

export class NeemDevReloadScheduler {
  private readonly operations = new OperationQueue({ strategy: 'latest' })
  private pendingFullReload = false
  private pendingRuntimeReloads = new Set<string>()
  private readonly scheduleFlush: (() => Promise<void>) & { cancel: () => void }

  constructor(private readonly options: NeemDevReloadSchedulerOptions) {
    this.scheduleFlush = debounce(() => this.queueFlush(), options.debounceMs)
  }

  requestFull(): void {
    if (this.options.isStopped()) return
    this.pendingFullReload = true
    this.pendingRuntimeReloads.clear()
    this.schedule()
  }

  requestRuntime(runtimeName: string): void {
    if (this.options.isStopped()) return
    if (!this.pendingFullReload) {
      this.pendingRuntimeReloads.add(runtimeName)
    }
    this.schedule()
  }

  stop(): void {
    this.scheduleFlush.cancel()
  }

  async drain(): Promise<void> {
    await this.operations.waitIdle()
  }

  private schedule(): void {
    this.options.onBegin()
    void this.scheduleFlush()
  }

  private queueFlush(): void {
    if (this.options.isStopped()) return
    void this.operations
      .run(() => this.flush())
      .catch((error) => {
        if (error instanceof OperationSupersededError) return
        this.options.onError(error)
      })
  }

  private async flush(): Promise<void> {
    if (this.options.isStopped()) return

    const request = this.takePending()
    if (!request) return

    try {
      await this.options.onFlush(request)
    } finally {
      if (!this.options.isStopped() && this.hasPending()) {
        this.schedule()
      }
    }
  }

  private takePending(): NeemDevReloadRequest | undefined {
    if (this.pendingFullReload) {
      this.pendingFullReload = false
      this.pendingRuntimeReloads.clear()
      return { type: 'full' }
    }

    if (this.pendingRuntimeReloads.size === 0) return undefined
    const runtimeNames = [...this.pendingRuntimeReloads]
    this.pendingRuntimeReloads.clear()
    return { type: 'runtimes', runtimeNames }
  }

  private hasPending(): boolean {
    return this.pendingFullReload || this.pendingRuntimeReloads.size > 0
  }
}
