import type { Future } from '@nmtjs/common'
import type { Logger } from 'pino'
import { createFuture, OperationQueue } from '@nmtjs/common'

import type { NeemLifecycleConfig } from '../../shared/types.ts'
import type { RuntimePatchResult } from '../host/runtime.ts'
import type { ThreadLifecycleEvent } from '../host/thread.ts'
import type { WorkerServiceStopProgressEvent } from '../services/client.ts'
import type { ConfigSignalWatcher } from '../services/config-signal.ts'
import type {
  WatcherCommands,
  WatcherEvent,
  WatcherManifestIdentity,
} from '../services/protocol.ts'
import type { NeemTestProbe } from '../test-probe.ts'
import { loadRuntimeSnapshot } from '../host/bootstrap.ts'
import { HostController } from '../host/controller.ts'
import {
  isOperationAborted,
  OperationScope,
  resolveLifecycle,
} from '../host/lifecycle.ts'
import {
  childLogger,
  createDefaultLogger,
  flushLogger,
  resolveManifestLogger,
} from '../logger.ts'
import { readManifest } from '../manifest/manifest.ts'
import { resolveServiceEntry, WorkerServiceClient } from '../services/client.ts'
import { watchConfigSignal } from '../services/config-signal.ts'
import {
  deserializeError,
  normalizeError,
  raceWithTimeout,
  serializeError,
  throwCollected,
} from '../utils.ts'
import { DevFreshness } from './freshness.ts'

type WatcherClient = WorkerServiceClient<WatcherCommands, WatcherEvent>

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
  // Only the first host start ends `neem dev` when it fails; a later one waits
  // for the next successful build instead.
  private hostStarted = false
  // Runtimes of the latest controller, kept for when none is running.
  private runtimeNames: readonly string[] = []
  // Recoveries of the current controller, held until the worker output they
  // restart from includes every patch the crashed threads accepted.
  private readonly recoveries = new Map<string, Future<void>>()
  private manifestFile: string | undefined
  // Restarts that find a stale worker failing to build wait here for its next
  // successful build rather than load output older than the running generation.
  private readonly freshness = new DevFreshness()
  // Threads registered with the current watcher; a new watcher knows none.
  private readonly patchClients = new Set<string>()
  // Resolved once per host generation; runtime reloads reuse it.
  private hostLogger: Logger | undefined
  // From the latest manifest; sizes the session's stop budget.
  private lifecycle: NeemLifecycleConfig | undefined
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

  /**
   * Stops the host and the watcher within one `lifecycle.stopTimeout` budget.
   * A failed shutdown rejects both this promise and `closed`.
   */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopped = true
    const scope = OperationScope.withTimeout(
      resolveLifecycle(this.lifecycle).stopTimeout,
    )
    // A watcher event may be awaiting host readiness. Deliver stop before
    // draining that queue so a pending start can finish its own cleanup.
    const controller = this.stopController(scope)
    return (this.stopping = (async () => {
      const errors: Error[] = []
      const collect = (error: unknown) => {
        errors.push(normalizeError(error))
      }
      await controller.catch(collect)
      // Stopping the watcher below settles an event still waiting on it.
      await raceWithTimeout(this.events.waitIdle(), scope.remaining())
      const watcher = this.watcher
      const configSignalWatcher = this.configSignalWatcher
      this.watcher = undefined
      this.configSignalWatcher = undefined
      const results = await Promise.allSettled([
        configSignalWatcher?.close(),
        watcher?.stop(scope),
      ])
      for (const result of results) {
        if (result.status === 'rejected') collect(result.reason)
      }
      // A failed session ends in the CLI's process.exit, which drops what
      // async log destinations still buffer.
      await flushLogger(this.logger, scope.remaining())
      this.options.probe?.emit('cli:dev:closed')
      try {
        throwCollected(errors, 'Neem dev session did not stop cleanly')
      } catch (error) {
        this.closedFuture.reject(error)
        throw error
      }
      this.closedFuture.resolve()
    })())
  }

  private enqueue(task: () => Promise<unknown>): void {
    void this.events.run(task).catch((error) => {
      // A stop interrupted the event; the stop reports its own outcome.
      if (isOperationAborted(error)) return
      this.closedFuture.reject(normalizeError(error))
    })
  }

  private async startWatcher(): Promise<void> {
    if (this.stopped) return
    // Until it has started, a failing watcher fails its start request instead.
    let started = false
    const watcher: WatcherClient = createWatcherClient({
      probe: this.options.probe,
      onEvent: (event) => {
        this.options.probe?.emit(`watcher:${event.type}`, normalizeEvent(event))
        this.enqueue(() => this.handleWatcherEvent(event))
      },
      onFailure: (error) => {
        if (started) this.onWatcherFailure(watcher, error)
      },
    })
    this.watcher = watcher
    this.patchClients.clear()
    try {
      const result = await watcher.request('start', {
        configFile: this.options.configFile,
        outDir: this.options.outDir,
        runtimes: this.options.runtimes,
      })
      started = true
      if (this.stopped) return
      this.manifestFile = result.manifestFile
      await this.startConfigSignalWatcher(result.configSignalFiles)
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
    this.freshness.reset()
    const previousSignalFiles = this.configSignalFiles
    this.watcher = undefined
    await this.retireController()
    await this.stopConfigSignalWatcher()
    await previousWatcher?.stop().catch(() => undefined)

    await this.startReplacementWatcher(previousSignalFiles)
  }

  // A failed replacement leaves only the config-signal watcher, so the next
  // config fix can start a watcher again.
  private async startReplacementWatcher(
    signalFiles: readonly string[] | undefined,
  ): Promise<boolean> {
    try {
      await this.startWatcher()
      return true
    } catch (error) {
      this.reportWatcherError(error)
      if (signalFiles) {
        await this.startConfigSignalWatcher(signalFiles, {
          tolerateInitialError: true,
        }).catch((signalError) => this.reportWatcherError(signalError))
      }
      return false
    }
  }

  private onWatcherFailure(watcher: WatcherClient, error: Error): void {
    // A dead worker reports an error and then its exit; one restart covers both.
    if (this.stopped || this.watcher !== watcher) return
    // Work queued ahead of the restart must not wait on the dead watcher.
    this.watcher = undefined
    this.enqueue(() => this.handleWatcherFailure(watcher, error))
  }

  // Rolldown state lives in the watcher thread so that a crash can discard it:
  // only the watcher restarts. Its replacement cleans the output directory and
  // builds everything again, and its ready event restarts the host from that
  // build, which also registers the new threads as its patch clients. Running
  // threads are not re-registered: their patch sequence belongs to the dead
  // watcher, and files may have changed while none was watching.
  private async handleWatcherFailure(
    watcher: WatcherClient,
    error: Error,
  ): Promise<void> {
    this.reportWatcherError(error)
    await watcher.stop().catch(() => undefined)
    if (this.stopped) return
    for (const runtimeName of this.controller?.getSnapshot().runtimeNames ??
      []) {
      this.freshness.markStale(runtimeName)
    }
    const signalFiles = this.configSignalFiles
    await this.stopConfigSignalWatcher()
    if (await this.startReplacementWatcher(signalFiles)) {
      this.options.probe?.emit('watcher:restarted')
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
    for (const runtimeName of this.freshness.staleRuntimes()) {
      if (await this.refreshWorkerOutput(runtimeName)) continue
      this.freshness.defer(runtimeName, 'restart')
      this.reportRestartDeferred(runtimeName)
      return false
    }
    this.freshness.restarted()
    let retired = false
    try {
      const manifest = await readManifest(this.manifestFile)
      // The logger artifact keeps its file name across dev rebuilds, so only a
      // cache-busted import picks up a changed logger for the next generation.
      this.hostLogger = await resolveManifestLogger(manifest.config.logger, {
        mode: 'development',
        outDir: this.options.outDir,
        cacheBust: true,
      })
      this.logger = childLogger(this.hostLogger, 'neem:server')
      await this.retireController()
      retired = true
      if (this.stopped) return false
      await this.startController(this.manifestFile)
    } catch (error) {
      if (!this.hostStarted) throw error
      if (this.stopped) return false
      await this.deferFailedRestart(error, retired)
      return false
    }
    return true
  }

  // Development never ends on a failed host restart, as on a failed runtime:
  // the restart waits for the next successful build. A controller that failed
  // to start is retired; one the restart never reached keeps serving.
  private async deferFailedRestart(
    error: unknown,
    retired: boolean,
  ): Promise<void> {
    const normalized = normalizeError(error)
    const runtimeNames = this.controller?.getSnapshot().runtimeNames
    if (retired) await this.retireController()
    this.logger.error(
      { err: normalized },
      'Neem server restart failed; it restarts after the next successful build',
    )
    this.options.probe?.emit('runtime:error', {
      type: 'error',
      error: serializeError(normalized),
    })
    // A worker patch alone does not rewrite the output the restart loads.
    for (const runtimeName of runtimeNames ?? this.runtimeNames) {
      this.freshness.markStale(runtimeName)
      this.freshness.defer(runtimeName, 'restart')
    }
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
    this.lifecycle = snapshot.config.lifecycle
    const controller: HostController = new HostController({
      snapshot,
      failOnWorkerError: true,
      recovery: { attempts: 1 },
      onThreadEvent: (event) => this.onThreadEvent(event),
      // Dev output on disk can lag patched threads; the session refreshes it
      // before a crashed runtime restarts from it.
      prepareRecovery: (runtimeName) =>
        this.awaitRecoveryOutput(controller, runtimeName),
      onFailure: (error, runtimeName) =>
        this.onRuntimeFailure(controller, error, runtimeName),
    })
    this.controller = controller
    this.runtimeNames = controller.getSnapshot().runtimeNames
    try {
      await controller.start()
    } catch (error) {
      // The session stopped this controller; stop() reports how that went.
      if (isOperationAborted(error)) return
      throw error
    }
    if (this.controller !== controller) return
    this.hostStarted = true
    this.options.probe?.emit('runtime:ready', {
      type: 'ready',
      health: controller.getHealth(),
    })
  }

  // Development never ends on a runtime failure: the runtime stays failed and
  // unready until its next successful build restarts it.
  private onRuntimeFailure(
    controller: HostController,
    error: Error,
    runtimeName: string,
  ): void {
    this.options.probe?.emit('runtime:error', {
      type: 'error',
      runtimeName,
      error: serializeError(error),
    })
    this.enqueue(async () => {
      if (this.stopped || this.controller !== controller) return
      this.logger.error(
        { err: error, runtimeName },
        'Neem runtime failed; it restarts after its next successful build',
      )
      // The source that failed is on disk; only a newer build can help.
      this.freshness.markStale(runtimeName)
      this.freshness.defer(runtimeName, 'reload')
    })
  }

  private async reloadRuntime(runtimeName: string): Promise<boolean> {
    if (!this.manifestFile) return false
    const controller = this.controller
    // No host runs after a failed restart; this build may be what it needs.
    if (!controller) {
      if (!this.freshness.hasPendingRestart()) return false
      return this.restartRuntime()
    }
    if (
      this.freshness.isStale(runtimeName) &&
      !(await this.refreshWorkerOutput(runtimeName))
    ) {
      this.freshness.defer(runtimeName, 'reload')
      this.reportRestartDeferred(runtimeName)
      return false
    }
    // The refresh above may be the one a deferred host restart waits for, and
    // that restart replaces this runtime as well.
    if (this.freshness.hasPendingRestart()) {
      if (await this.restartRuntime()) return true
      // A failed restart retired the controller this reload was meant for.
      if (this.controller !== controller) return false
    }
    this.freshness.resume(runtimeName, 'reload')
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

  // Fresh output already includes the patched code, so a restart that ran
  // replaces applying the patch.
  private async resumeDeferredRestart(runtimeName: string): Promise<boolean> {
    switch (this.freshness.resumable(runtimeName)) {
      case 'restart':
        return this.restartRuntime()
      case 'reload':
        return this.reloadRuntime(runtimeName)
      case 'recovery':
        return this.prepareRecovery(runtimeName)
      case undefined:
        return false
    }
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
      this.freshness.isStale(runtimeName) &&
      !(await this.refreshWorkerOutput(runtimeName))
    ) {
      this.freshness.defer(runtimeName, 'recovery')
      this.reportRestartDeferred(runtimeName)
      return false
    }
    // A deferred host restart replaces the recovering runtime too, and it
    // releases every recovery of the controller it retires.
    if (this.freshness.hasPendingRestart() && (await this.restartRuntime())) {
      return true
    }
    this.freshness.resume(runtimeName, 'recovery')
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
    const watcher = this.watcher
    if (this.stopped || !watcher) return
    const { runtimeName, threadId, type } = event
    const started = type === 'thread-started'
    // Only the watcher a thread registered with can unregister it.
    if (!started && !this.patchClients.delete(threadId)) return
    try {
      await watcher.request(
        started ? 'patch-client-started' : 'patch-client-stopped',
        { runtimeName, clientId: threadId },
      )
    } catch (error) {
      // A watcher that died meanwhile is restarting with the runtime.
      if (this.watcher !== watcher) return
      throw error
    }
    if (started && this.watcher === watcher) this.patchClients.add(threadId)
  }

  private async applyPatch(
    event: Extract<WatcherEvent, { type: 'worker-patch' }>,
  ): Promise<void> {
    const { runtimeName, updates } = event
    // No host runs after a failed restart, and the deferred restart has just
    // retried on this build, so there is nothing to patch.
    if (!this.controller) return
    if (!updates.length) {
      await this.fallback(runtimeName, 'No active patch clients')
      return
    }
    let patch: RuntimePatchResult | undefined
    try {
      patch = await this.controller?.applyPatch(runtimeName, updates)
      if (patch?.deliveredFiles.length) {
        await this.watcher?.request('patch-delivered', {
          runtimeName,
          filenames: patch.deliveredFiles,
        })
      }
    } catch (error) {
      if (isOperationAborted(error) || this.stopped) return
      // An unavailable generation is already recovering; a reload on top of
      // that recovery would restart the runtime twice.
      if (patch?.outcome !== 'unavailable') {
        await this.fallback(runtimeName, normalizeError(error).message)
        return
      }
    }
    switch (patch?.outcome) {
      case 'applied':
        // Refreshing here would race later edits: a full DevEngine build can
        // absorb a pending change without emitting its patch. Restarts refresh.
        this.freshness.markStale(runtimeName)
        this.options.probe?.emit('runtime:patch-applied', {
          runtimeName,
          reason: 'Worker generation updated',
        })
        return
      case 'unavailable':
        this.reportPatchUnavailable(runtimeName, patch.reason)
        return
      default:
        await this.fallback(
          runtimeName,
          patch?.reason ?? 'Runtime rejected the patch',
        )
    }
  }

  // The runtime has already failed the retired threads, and its recovery
  // restarts them. That recovery waits in prepareRecovery for output that
  // includes this update, which so far exists only as a patch chunk.
  private reportPatchUnavailable(runtimeName: string, reason: string): void {
    this.freshness.markStale(runtimeName)
    this.logger.warn(
      { runtimeName, reason },
      'Neem worker generation retired by a failed patch; restarting the runtime from current output',
    )
    this.options.probe?.emit('runtime:patch-unavailable', {
      runtimeName,
      reason,
    })
    // Still a patch that ended in a restart, as every fallback does.
    this.options.probe?.emit('runtime:patch-fallback', { runtimeName, reason })
  }

  private reportRestartDeferred(runtimeName: string): void {
    const serving = this.controller
      ?.getHealth()
      .runtimes.some((runtime) => runtime.name === runtimeName && runtime.ready)
    this.logger.warn(
      { runtimeName },
      serving
        ? 'Neem restart deferred until the runtime worker builds again; the running generation keeps serving'
        : 'Neem restart deferred until the runtime worker builds again; the runtime is not serving',
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
    this.freshness.markStale(runtimeName)
    await this.reloadRuntime(runtimeName)
  }

  // Leaves the runtime stale when the latest source fails to build; a deferred
  // restart retries once the worker builds again.
  private async refreshWorkerOutput(runtimeName: string): Promise<boolean> {
    try {
      const manifest = await this.watcher?.request('ensure-worker-output', {
        runtimeName,
      })
      if (!manifest) return false
      this.acceptManifest(manifest)
      this.freshness.outputRefreshed(runtimeName)
      return true
    } catch (error) {
      this.logger.error(
        { err: normalizeError(error), runtimeName },
        'Neem worker output refresh failed',
      )
      return false
    }
  }

  private async stopController(scope?: OperationScope): Promise<void> {
    const controller = this.controller
    this.controller = undefined
    for (const runtimeName of this.recoveries.keys())
      this.releaseRecovery(runtimeName)
    if (!controller) return
    try {
      await controller.stop(scope)
    } finally {
      this.options.probe?.emit('runtime:stopped', { type: 'stopped' })
    }
  }

  // A restart replaces the generation either way; an unclean stop of the old
  // one is reported without ending the session.
  private async retireController(): Promise<void> {
    await this.stopController().catch((error) => {
      this.logger.error(
        { err: normalizeError(error) },
        'Neem server did not stop cleanly',
      )
    })
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
  return new WorkerServiceClient<WatcherCommands, WatcherEvent>({
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
