import type { Future } from '@nmtjs/common'
import type { Logger } from 'pino'
import { createFuture, OperationQueue } from '@nmtjs/common'

import type { ThreadLifecycleEvent } from '../host/thread.ts'
import type { WorkerServiceStopProgressEvent } from '../services/client.ts'
import type { ConfigSignalWatcher } from '../services/config-signal.ts'
import type {
  WatcherEvent,
  WatcherManifestIdentity,
  WatcherResult,
} from '../services/protocol.ts'
import type { NeemTestProbe } from '../test-probe.ts'
import { loadRuntimeSnapshot } from '../host/bootstrap.ts'
import { HostController } from '../host/controller.ts'
import {
  childLogger,
  createDefaultLogger,
  resolveManifestLogger,
} from '../logger.ts'
import { readManifest } from '../manifest/manifest.ts'
import { resolveServiceEntry, WorkerServiceClient } from '../services/client.ts'
import { watchConfigSignal } from '../services/config-signal.ts'
import { deserializeError, normalizeError, serializeError } from '../utils.ts'

type WatcherClient = WorkerServiceClient<WatcherEvent, WatcherResult>

export type DevSessionOptions = {
  configFile: string
  outDir: string
  runtimes?: readonly string[]
  signal: AbortSignal
  probe?: NeemTestProbe
}

export class DevSession {
  readonly closed: Promise<void>

  private readonly closedFuture = createFuture<void>()
  private readonly events = new OperationQueue()
  private watcher: WatcherClient | undefined
  private configSignalWatcher: ConfigSignalWatcher | undefined
  private configSignalFiles: readonly string[] | undefined
  private controller: HostController | undefined
  // Recoveries of the current controller, held until the worker output they
  // restart from includes every patch the crashed threads accepted.
  private readonly recoveries = new Map<string, Future<void>>()
  private manifestFile: string | undefined
  // Runtimes whose worker output on disk predates their running generation.
  private readonly staleWorkers = new Set<string>()
  // Restarts that found a stale worker failing to build. They wait for its next
  // successful build rather than load output older than the running generation.
  private readonly deferredReloads = new Set<string>()
  private readonly deferredRecoveries = new Set<string>()
  private restartDeferred = false
  // Resolved once per host generation; runtime reloads reuse it.
  private hostLogger: Logger | undefined
  private logger = childLogger(
    createDefaultLogger('development'),
    'neem:server',
  )
  private stopped = false
  private stopping: Promise<void> | undefined

  constructor(private readonly options: DevSessionOptions) {
    this.closed = this.closedFuture.promise
    this.closed.catch(() => {})

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

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    // A watcher event may be awaiting host readiness. Deliver stop before
    // draining that queue so a pending start can finish its own cleanup.
    const controller = this.stopController()
    return (this.stopping = (async () => {
      await Promise.all([controller, this.events.waitIdle()])
      const watcher = this.watcher
      const configSignalWatcher = this.configSignalWatcher
      this.watcher = undefined
      this.configSignalWatcher = undefined
      await Promise.all([configSignalWatcher?.close(), watcher?.stop()])
      this.options.probe?.emit('cli:dev:closed')
      this.closedFuture.resolve()
    })())
  }

  private enqueue(task: () => Promise<unknown>): void {
    void this.events.run(task).catch((error) => {
      this.closedFuture.reject(normalizeError(error))
    })
  }

  private async startWatcher(): Promise<void> {
    if (this.stopped) return
    const watcher = createWatcherClient({
      probe: this.options.probe,
      onEvent: (event) => {
        this.options.probe?.emit(`watcher:${event.type}`, normalizeEvent(event))
        this.enqueue(() => this.handleWatcherEvent(event))
      },
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
      if (this.stopped) return
      if (result?.manifestFile) this.manifestFile = result.manifestFile
      if (result?.configSignalFiles) {
        await this.startConfigSignalWatcher(result.configSignalFiles)
      }
    } catch (error) {
      if (this.watcher === watcher) this.watcher = undefined
      await watcher.stop().catch(() => undefined)
      throw error
    }
  }

  private async handleWatcherEvent(event: WatcherEvent): Promise<void> {
    if (this.stopped) return

    switch (event.type) {
      case 'ready':
        this.acceptManifest(event)
        await this.restartRuntime()
        return
      case 'config-invalidated':
        await this.replaceWatcher()
        return
      case 'runtime-changed':
      case 'runtime-host-changed':
        this.acceptManifest(event)
        await this.reloadRuntime(event.runtimeName)
        return
      case 'plugin-changed':
      case 'logger-changed':
        this.acceptManifest(event)
        await this.restartRuntime()
        return
      case 'worker-patch':
        if (await this.resumeDeferredRestart(event.runtimeName)) return
        await this.applyPatch(event)
        return
      case 'worker-patch-failed':
        this.reportPatchFallback(event.runtimeName, event.reason)
        return
      case 'error':
        this.logger.error(
          { err: deserializeError(event.error) },
          'Neem watcher build failed',
        )
        return
    }
  }

  private async replaceWatcher(): Promise<void> {
    const previousWatcher = this.watcher
    this.staleWorkers.clear()
    this.deferredReloads.clear()
    this.deferredRecoveries.clear()
    this.restartDeferred = false
    const previousSignalFiles = this.configSignalFiles
    this.watcher = undefined
    await this.stopController()
    await this.stopConfigSignalWatcher()
    await previousWatcher?.stop().catch(() => undefined)

    try {
      await this.startWatcher()
    } catch (error) {
      this.reportWatcherError(error)
      if (previousSignalFiles) {
        await this.startConfigSignalWatcher(previousSignalFiles, {
          tolerateInitialError: true,
        }).catch((signalError) => this.reportWatcherError(signalError))
      }
      return
    }
  }

  private async startConfigSignalWatcher(
    files: readonly string[],
    options: { tolerateInitialError?: boolean } = {
      tolerateInitialError: true,
    },
  ): Promise<void> {
    await this.stopConfigSignalWatcher()
    if (this.stopped) return
    this.configSignalFiles = [...files]
    const watcher = await watchConfigSignal({
      files,
      tolerateInitialError: options.tolerateInitialError,
      onInvalidated: () => this.handleConfigSignalInvalidated(),
    })
    if (this.stopped) await watcher.close()
    else this.configSignalWatcher = watcher
  }

  private async stopConfigSignalWatcher(): Promise<void> {
    const watcher = this.configSignalWatcher
    this.configSignalWatcher = undefined
    await watcher?.close()
  }

  private handleConfigSignalInvalidated(): void {
    if (this.stopped) return
    const event = { type: 'config-invalidated' } as const
    this.options.probe?.emit(`watcher:${event.type}`, normalizeEvent(event))
    this.enqueue(() => this.handleWatcherEvent(event))
  }

  private reportWatcherError(error: unknown): void {
    this.logger.error({ err: normalizeError(error) }, 'Neem watcher failed')
    this.options.probe?.emit(
      'watcher:error',
      normalizeEvent({ type: 'error', error: serializeError(error) }),
    )
  }

  private async restartRuntime(): Promise<boolean> {
    if (!this.manifestFile) return false
    for (const runtimeName of this.staleWorkers) {
      if (await this.refreshWorkerOutput(runtimeName)) continue
      this.restartDeferred = true
      this.reportRestartDeferred(runtimeName)
      return false
    }
    this.restartDeferred = false
    this.deferredReloads.clear()
    this.deferredRecoveries.clear()
    const manifest = await readManifest(this.manifestFile)
    // The logger artifact keeps its file name across dev rebuilds, so only a
    // cache-busted import picks up a changed logger for the next generation.
    this.hostLogger = await resolveManifestLogger(manifest.config.logger, {
      mode: 'development',
      outDir: this.options.outDir,
      cacheBust: true,
    })
    this.logger = childLogger(this.hostLogger, 'neem:server')
    await this.stopController()
    if (this.stopped) return false
    await this.startController(this.manifestFile)
    return true
  }

  private async startController(manifestFile: string): Promise<void> {
    const snapshot = await loadRuntimeSnapshot({
      mode: 'development',
      outDir: this.options.outDir,
      manifestFile,
      runtimes: this.options.runtimes,
      logger: this.hostLogger,
    })
    // stop() only reaches a controller once it is published below.
    if (this.stopped) return
    const controller: HostController = new HostController({
      snapshot,
      failOnWorkerError: true,
      recovery: { attempts: 1 },
      onThreadEvent: (event) => this.onThreadEvent(event),
      // Dev output on disk can lag patched threads; the session refreshes it
      // before a crashed runtime restarts from it.
      prepareRecovery: (runtimeName) =>
        this.awaitRecoveryOutput(controller, runtimeName),
      onFailure: (error) => {
        this.options.probe?.emit('runtime:error', {
          type: 'error',
          error: serializeError(error),
        })
        this.closedFuture.reject(error)
      },
    })
    this.controller = controller
    await controller.start()
    if (this.controller !== controller) return
    this.options.probe?.emit('runtime:ready', {
      type: 'ready',
      health: controller.getHealth(),
    })
  }

  private async reloadRuntime(runtimeName: string): Promise<boolean> {
    const controller = this.controller
    if (!controller || !this.manifestFile) return false
    if (
      this.staleWorkers.has(runtimeName) &&
      !(await this.refreshWorkerOutput(runtimeName))
    ) {
      this.deferredReloads.add(runtimeName)
      this.reportRestartDeferred(runtimeName)
      return false
    }
    this.deferredReloads.delete(runtimeName)
    this.deferredRecoveries.delete(runtimeName)
    // The reload replaces a recovering runtime, which must not keep waiting.
    this.releaseRecovery(runtimeName)
    const snapshot = await loadRuntimeSnapshot({
      mode: 'development',
      outDir: this.options.outDir,
      manifestFile: this.manifestFile,
      runtimes: this.options.runtimes,
      logger: this.hostLogger,
    })
    await controller.reloadRuntime(runtimeName, snapshot)
    return true
  }

  // A worker patch means the worker builds again, so a restart deferred on its
  // stale output can run now; fresh output already includes the patched code.
  private async resumeDeferredRestart(runtimeName: string): Promise<boolean> {
    if (!this.staleWorkers.has(runtimeName)) return false
    if (this.restartDeferred) return this.restartRuntime()
    if (this.deferredRecoveries.has(runtimeName))
      return this.prepareRecovery(runtimeName)
    if (!this.deferredReloads.has(runtimeName)) return false
    return this.reloadRuntime(runtimeName)
  }

  private awaitRecoveryOutput(
    controller: HostController,
    runtimeName: string,
  ): Promise<void> {
    // Nothing would release a retired controller's recovery, and its stop must
    // not wait on one.
    if (this.controller !== controller) return Promise.resolve()
    let recovery = this.recoveries.get(runtimeName)
    if (!recovery) {
      recovery = createFuture<void>()
      this.recoveries.set(runtimeName, recovery)
      this.options.probe?.emit('runtime:runtime-recovering', {
        type: 'runtime-recovering',
        runtimeName,
      })
      this.enqueue(() => this.prepareRecovery(runtimeName))
    }
    return recovery.promise
  }

  // Host recovery restarts a crashed runtime from the files on disk, so it
  // waits here until they include every patch the crashed threads accepted.
  private async prepareRecovery(runtimeName: string): Promise<boolean> {
    if (this.stopped || !this.controller) return false
    if (
      this.staleWorkers.has(runtimeName) &&
      !(await this.refreshWorkerOutput(runtimeName))
    ) {
      this.deferredRecoveries.add(runtimeName)
      this.reportRestartDeferred(runtimeName)
      return false
    }
    this.deferredRecoveries.delete(runtimeName)
    this.releaseRecovery(runtimeName)
    return true
  }

  private releaseRecovery(runtimeName: string): void {
    this.recoveries.get(runtimeName)?.resolve()
    this.recoveries.delete(runtimeName)
  }

  private onThreadEvent(event: ThreadLifecycleEvent): void {
    this.options.probe?.emit(`runtime:${event.type}`, { ...event })
    this.enqueue(() => this.handleThreadEvent(event))
  }

  private async handleThreadEvent(event: ThreadLifecycleEvent): Promise<void> {
    if (this.stopped) return
    const { runtimeName, threadId, type } = event
    await this.watcher?.request({
      type:
        type === 'thread-started'
          ? 'patch-client-started'
          : 'patch-client-stopped',
      runtimeName,
      clientId: threadId,
    })
  }

  private async applyPatch(
    event: Extract<WatcherEvent, { type: 'worker-patch' }>,
  ): Promise<void> {
    const { runtimeName, updates } = event
    if (!updates.length) {
      await this.fallback(runtimeName, 'No active patch clients')
      return
    }
    try {
      const patch = await this.controller?.applyPatch(runtimeName, updates)
      if (patch?.deliveredFiles.length) {
        await this.watcher?.request({
          type: 'patch-delivered',
          runtimeName,
          filenames: patch.deliveredFiles,
        })
      }
      if (patch?.accepted) {
        // Refreshing here would race later edits: a full DevEngine build can
        // absorb a pending change without emitting its patch. Restarts refresh.
        this.staleWorkers.add(runtimeName)
        this.options.probe?.emit('runtime:patch-applied', {
          runtimeName,
          reason: 'Worker generation updated',
        })
      }
      if (!patch?.accepted || patch.reset) {
        await this.fallback(
          runtimeName,
          patch?.reason ?? 'Runtime rejected the patch',
        )
      }
    } catch (error) {
      if (!this.stopped)
        await this.fallback(runtimeName, normalizeError(error).message)
    }
  }

  private reportRestartDeferred(runtimeName: string): void {
    this.logger.warn(
      { runtimeName },
      'Neem restart deferred until the runtime worker builds again; the running generation keeps serving',
    )
    this.options.probe?.emit('runtime:restart-deferred', { runtimeName })
  }

  private reportPatchFallback(runtimeName: string, reason: string): void {
    this.logger.warn({ runtimeName, reason }, 'Neem runtime restart fallback')
    this.options.probe?.emit('runtime:patch-fallback', { runtimeName, reason })
  }

  private async fallback(runtimeName: string, reason: string): Promise<void> {
    if (this.stopped) return
    this.reportPatchFallback(runtimeName, reason)
    // The rejected update exists only in source; the restart needs fresh output.
    this.staleWorkers.add(runtimeName)
    await this.reloadRuntime(runtimeName)
  }

  // Leaves the runtime stale when the latest source fails to build; a deferred
  // restart retries once the worker builds again.
  private async refreshWorkerOutput(runtimeName: string): Promise<boolean> {
    try {
      const result = await this.watcher?.request({
        type: 'ensure-worker-output',
        runtimeName,
      })
      if (!result?.manifest) return false
      this.acceptManifest(result.manifest)
      this.staleWorkers.delete(runtimeName)
      return true
    } catch (error) {
      this.logger.error(
        { err: normalizeError(error), runtimeName },
        'Neem worker output refresh failed',
      )
      return false
    }
  }

  private async stopController(): Promise<void> {
    const controller = this.controller
    this.controller = undefined
    for (const runtimeName of this.recoveries.keys())
      this.releaseRecovery(runtimeName)
    if (!controller) return
    await controller.stop()
    this.options.probe?.emit('runtime:stopped', { type: 'stopped' })
  }

  // Every manifest snapshot is cumulative and written to the same file, so an
  // event stamped before a later refresh still describes a change to apply.
  private acceptManifest(event: WatcherManifestIdentity): void {
    this.manifestFile = event.manifestFile
  }
}

function createWatcherClient(options: {
  probe?: NeemTestProbe
  onEvent: (event: WatcherEvent) => void
  onFailure: (error: Error) => void
}): WatcherClient {
  return new WorkerServiceClient<WatcherEvent, WatcherResult>({
    entry: resolveServiceEntry('watcher-entry'),
    serviceName: 'watcher',
    onStopProgress: (event) => reportServiceStopProgress(options.probe, event),
    ...options,
  })
}

function reportServiceStopProgress(
  probe: NeemTestProbe | undefined,
  event: WorkerServiceStopProgressEvent,
): void {
  probe?.emit(`service:stop-${event.phase}`, event)
  switch (event.phase) {
    case 'slow':
      process.stderr.write(
        `Neem ${event.serviceName} service worker still stopping after ${event.elapsedMs}ms\n`,
      )
      return
    case 'timeout':
      process.stderr.write(
        `Neem ${event.serviceName} service stop timed out after ${event.timeoutMs}ms; terminating worker\n`,
      )
      return
    case 'complete': {
      const action = event.exited ? 'stopped' : 'did not stop'
      process.stderr.write(
        `Neem ${event.serviceName} service worker ${action} after ${event.elapsedMs}ms\n`,
      )
    }
  }
}

function normalizeEvent(event: { error?: unknown } & Record<string, unknown>) {
  return event.error
    ? {
        ...event,
        error: isSerializedError(event.error)
          ? event.error
          : serializeError(event.error),
      }
    : event
}

function isSerializedError(
  value: unknown,
): value is { message: string; name?: string; stack?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { message?: unknown }).message === 'string'
  )
}
