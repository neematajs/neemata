import { createFuture, noopFn, OperationQueue } from '@nmtjs/common'

import type { WorkerServiceClient } from '../services/client.ts'
import type { ConfigSignalWatcher } from '../services/config-signal.ts'
import type {
  RuntimeCommand,
  RuntimeEvent,
  RuntimeResult,
  WatcherCommand,
  WatcherEvent,
  WatcherManifestIdentity,
  WatcherResult,
} from '../services/protocol.ts'
import type { NeemTestProbe } from '../test-probe.ts'
import { watchConfigSignal } from '../services/config-signal.ts'
import { createNeemTestProbe } from '../test-probe.ts'
import { deserializeError, normalizeError, serializeError } from '../utils.ts'
import { createServiceClient } from './clients.ts'
import { createSignalController } from './signal.ts'

type RuntimeClient = WorkerServiceClient<
  RuntimeCommand,
  RuntimeEvent,
  RuntimeResult
>
type WatcherClient = WorkerServiceClient<
  WatcherCommand,
  WatcherEvent,
  WatcherResult
>

export type DevOptions = {
  configFile: string
  outDir: string
  runtimes?: readonly string[]
}

export async function runDev(options: DevOptions): Promise<void> {
  const controller = createSignalController()
  const supervisor = new DevSupervisor({
    ...options,
    signal: controller.signal,
    probe: createNeemTestProbe(),
  })

  try {
    await supervisor.start()
    await supervisor.closed
  } finally {
    controller.dispose()
    // The command is already returning: a failing teardown must not mask the
    // original outcome.
    await supervisor.stop().catch(noopFn)
  }
}

type DevSupervisorOptions = DevOptions & {
  signal: AbortSignal
  probe?: NeemTestProbe
}

class DevSupervisor {
  readonly closed: Promise<void>

  private readonly closedFuture = createFuture<void>()
  private readonly events = new OperationQueue()
  private watcher: WatcherClient | undefined
  private configSignalWatcher: ConfigSignalWatcher | undefined
  private configSignalFiles: readonly string[] | undefined
  private runtime: RuntimeClient | undefined
  private manifestFile: string | undefined
  private manifestRevision = 0
  private stopped = false

  constructor(private readonly options: DevSupervisorOptions) {
    this.closed = this.closedFuture.promise
    // `closed` is also awaited by the caller; this guard keeps an early
    // rejection from surfacing as an unhandled rejection before then.
    this.closed.catch(noopFn)

    if (options.signal.aborted) this.stopped = true
    options.signal.addEventListener(
      'abort',
      () => {
        void this.stop()
      },
      { once: true },
    )
  }

  async start(): Promise<void> {
    this.options.probe?.emit('cli:dev:start')
    await this.startWatcher()
  }

  async stop(): Promise<void> {
    if (this.stopped && !this.watcher && !this.runtime) return
    this.stopped = true
    await this.events.waitIdle()
    const watcher = this.watcher
    const configSignalWatcher = this.configSignalWatcher
    const runtime = this.runtime
    this.watcher = undefined
    this.configSignalWatcher = undefined
    this.runtime = undefined
    await Promise.all([
      configSignalWatcher?.close(),
      watcher?.stop(),
      runtime?.stop(),
    ])
    this.options.probe?.emit('cli:dev:closed')
    this.closedFuture.resolve()
  }

  private async startWatcher(): Promise<void> {
    if (this.stopped) return
    const watcher = createServiceClient<
      WatcherCommand,
      WatcherEvent,
      WatcherResult
    >('watcher', {
      probe: this.options.probe,
      onEvent: (event) => this.enqueue(event),
      onFailure: (error) => this.closedFuture.reject(error),
    })
    this.watcher = watcher
    try {
      const result = await watcher.request({
        type: 'start',
        configFile: this.options.configFile,
        outDir: this.options.outDir,
        runtimes: this.options.runtimes,
      })
      if (result?.manifestFile) this.manifestFile = result.manifestFile
      if (result?.configSignalFiles) {
        await this.startConfigSignalWatcher(result.configSignalFiles)
      }
    } catch (error) {
      if (this.watcher === watcher) this.watcher = undefined
      // The start failure is rethrown; a failing stop of the half-started
      // service worker must not replace it.
      await watcher.stop().catch(noopFn)
      throw error
    }
  }

  private enqueue(event: WatcherEvent): void {
    this.options.probe?.emit(`watcher:${event.type}`, event)
    void this.events
      .run(() => this.handleWatcherEvent(event))
      .catch((error) => {
        this.closedFuture.reject(normalizeError(error))
      })
  }

  private async handleWatcherEvent(event: WatcherEvent): Promise<void> {
    if (this.stopped) return

    switch (event.type) {
      case 'ready':
        this.acceptManifest(event, { resetRevision: true })
        await this.restartRuntime()
        return
      case 'config-invalidated':
        await this.replaceWatcher()
        return
      case 'runtime-changed':
      case 'runtime-host-changed':
        if (!this.acceptManifest(event)) return
        await this.reloadRuntime(event.runtimeName)
        return
      case 'plugin-changed':
      case 'logger-changed':
        if (!this.acceptManifest(event)) return
        await this.restartRuntime()
        return
      case 'error':
        return
    }
  }

  private async replaceWatcher(): Promise<void> {
    const previousWatcher = this.watcher
    const previousSignalFiles = this.configSignalFiles
    this.watcher = undefined
    await this.stopRuntime()
    await this.stopConfigSignalWatcher()
    // The watcher is being replaced because its config broke; a failing stop
    // must not abort the replacement.
    await previousWatcher?.stop().catch(noopFn)

    try {
      await this.startWatcher()
    } catch (error) {
      this.reportWatcherError(error)
      if (previousSignalFiles) {
        await this.startConfigSignalWatcher(previousSignalFiles).catch(
          (signalError) => this.reportWatcherError(signalError),
        )
      }
    }
  }

  private async startConfigSignalWatcher(
    files: readonly string[],
  ): Promise<void> {
    await this.stopConfigSignalWatcher()
    this.configSignalFiles = [...files]
    this.configSignalWatcher = await watchConfigSignal({
      files,
      // This watcher exists to notice a fixed config, so it has to survive the
      // broken config that made the dev supervisor restart it.
      tolerateInitialError: true,
      onInvalidated: () => this.handleConfigSignalInvalidated(),
    })
  }

  private async stopConfigSignalWatcher(): Promise<void> {
    const watcher = this.configSignalWatcher
    this.configSignalWatcher = undefined
    await watcher?.close()
  }

  private handleConfigSignalInvalidated(): void {
    if (this.stopped) return
    this.enqueue({ type: 'config-invalidated' })
  }

  private reportWatcherError(error: unknown): void {
    this.options.probe?.emit('watcher:error', {
      type: 'error',
      error: serializeError(error),
    })
  }

  private async restartRuntime(): Promise<void> {
    if (!this.manifestFile) return
    await this.stopRuntime()
    const runtime = createServiceClient<
      RuntimeCommand,
      RuntimeEvent,
      RuntimeResult
    >('runtime', {
      probe: this.options.probe,
      onEvent: (event) => {
        this.options.probe?.emit(`runtime:${event.type}`, event)
        if (event.type === 'error') {
          this.closedFuture.reject(deserializeError(event.error))
        }
      },
      onFailure: (error) => this.closedFuture.reject(error),
    })
    this.runtime = runtime
    await runtime.request({
      type: 'start',
      mode: 'development',
      outDir: this.options.outDir,
      manifestFile: this.manifestFile,
      runtimes: this.options.runtimes,
    })
  }

  private async reloadRuntime(runtimeName: string): Promise<void> {
    if (!this.runtime || !this.manifestFile) return
    await this.runtime.request({
      type: 'reload-runtime',
      runtimeName,
      manifestFile: this.manifestFile,
    })
  }

  private async stopRuntime(): Promise<void> {
    const runtime = this.runtime
    this.runtime = undefined
    await runtime?.stop()
  }

  private acceptManifest(
    event: WatcherManifestIdentity,
    options: { resetRevision?: boolean } = {},
  ): boolean {
    const stale =
      !options.resetRevision &&
      event.manifestFile === this.manifestFile &&
      event.manifestRevision < this.manifestRevision
    if (stale) return false

    this.manifestFile = event.manifestFile
    this.manifestRevision = event.manifestRevision
    return true
  }
}
