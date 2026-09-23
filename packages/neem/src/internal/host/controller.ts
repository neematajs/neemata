import { performance } from 'node:perf_hooks'

import type { BindingClientHmrUpdate } from 'rolldown/experimental'
import { OperationQueue } from '@nmtjs/common'

import type {
  NeemProxyHealth,
  NeemRuntimeServerHealth,
  NeemRuntimeServerSnapshot,
  NeemRuntimeServerState,
  NeemRuntimeUpstream,
} from '../../shared/types.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { HostHooks } from '../plugins/hooks.ts'
import type { RuntimeUpstreams } from './proxy.ts'
import type { RecoveryOptions } from './recovery.ts'
import type { RuntimePatchResult } from './runtime.ts'
import type { ThreadLifecycleEvent } from './thread.ts'
import { childLogger } from '../logger.ts'
import { PluginEnvironment } from '../plugins/environment.ts'
import { callHostHook, createHostHooks } from '../plugins/hooks.ts'
import { normalizeError, raceWithTimeout } from '../utils.ts'
import { HealthProbe } from './health.ts'
import {
  isOperationAborted,
  OperationScope,
  resolveLifecycle,
  throwCollected,
} from './lifecycle.ts'
import { ProxyController } from './proxy.ts'
import { RuntimeController } from './runtime.ts'

export type HostControllerOptions = {
  onThreadEvent?: (event: ThreadLifecycleEvent) => void
  prepareRecovery?: (runtimeName: string) => Promise<void>
  snapshot: RuntimeSnapshot
  hooks?: HostHooks
  failOnWorkerError?: boolean
  recovery?: RecoveryOptions
  // Reports a runtime whose failure recovery could not repair.
  onFailure?: (error: Error, runtimeName: string) => void
}

/**
 * Owns the server lifecycle. Start, reload, runtime reload and patch run one at
 * a time as operations of the current lifetime; stop() is never queued behind
 * them: it aborts the lifetime, joins whatever is in flight, then cleans up.
 */
export class HostController {
  private state: NeemRuntimeServerState = 'idle'
  private revision = 0
  private lastError: Error | undefined
  private snapshot: RuntimeSnapshot
  private logger: RuntimeSnapshot['logger']
  private readonly hooks: HostHooks
  private readonly operations = new OperationQueue()
  // Parent of every operation requested before the next stop.
  private lifetime = new OperationScope()
  private stopping: Promise<void> | undefined
  private runtimes = new Map<string, RuntimeController>()
  private proxy: ProxyController | undefined
  private healthProbe: HealthProbe | undefined
  private plugins: PluginEnvironment | undefined

  constructor(readonly options: HostControllerOptions) {
    this.snapshot = options.snapshot
    this.logger = childLogger(options.snapshot.logger, 'neem:server')
    this.hooks = options.hooks ?? createHostHooks()
  }

  getSnapshot(): NeemRuntimeServerSnapshot {
    return {
      mode: this.snapshot.mode,
      outDir: this.snapshot.outDir,
      runtimeNames: Object.keys(this.snapshot.manifest.runtimes),
      artifactCount: this.snapshot.artifacts.list().length,
      state: this.state,
      revision: this.revision,
      lastError: this.lastError,
    }
  }

  getHealth(): NeemRuntimeServerHealth {
    const runtimes = [...this.runtimes.values()].map((runtime) =>
      runtime.getHealth(),
    )
    const proxy = this.proxy?.getHealth() ?? this.getDisabledProxyHealth()

    return {
      ...this.getSnapshot(),
      ready:
        this.state === 'running' &&
        runtimes.every((runtime) => runtime.ready) &&
        (!proxy.enabled || proxy.ready),
      runtimes,
      proxy,
    }
  }

  getUpstreams(): readonly NeemRuntimeUpstream[] {
    return [...this.runtimes.values()].flatMap((runtime) =>
      runtime.getUpstreams(),
    )
  }

  /** Rejects with OperationAbortedError when a stop interrupts it. */
  start(): Promise<void> {
    return this.runOperation(async (scope) => {
      if (this.state === 'running') return
      this.markState('starting')
      this.logger.info('Neem server starting')
      this.logger.trace(
        {
          mode: this.snapshot.mode,
          runtimes: Object.keys(this.snapshot.manifest.runtimes),
          outDir: this.snapshot.outDir,
          config: this.snapshot.manifest.config,
        },
        'Neem server options',
      )

      await this.bringUp(scope, {
        readyHook: 'server:ready',
        onReady: () => this.logger.info('Neem server ready'),
        failMessage: 'Failed to start Neem server',
      })
    })
  }

  /** Rejects with OperationAbortedError when a stop interrupts it. */
  reload(snapshot: RuntimeSnapshot): Promise<void> {
    return this.runOperation(async (scope) => {
      this.markState('reloading')
      this.logger.debug('Neem server reloading')
      this.logger.trace(
        {
          mode: snapshot.mode,
          runtimes: Object.keys(snapshot.manifest.runtimes),
          outDir: snapshot.outDir,
          config: snapshot.manifest.config,
        },
        'Neem server options',
      )

      await this.bringUp(scope, {
        prepare: async () => {
          await this.stopSubsystems(this.createStopScope()).catch((error) =>
            this.reportUncleanStop(error),
          )
          this.replaceSnapshot(snapshot)
        },
        readyHook: 'server:reload',
        onReady: () => this.logger.debug('Neem server reloaded'),
        failMessage: 'Failed to reload Neem server',
      })
    })
  }

  // Shared start/reload bring-up: identical subsystem ordering and error
  // handling, differing only in the reload prelude and success hook/log.
  // Subsystems this operation acquires itself are awaited to completion, so
  // stop() never cleans up next to a half-started one; waits on hooks and
  // workers end as soon as the scope is aborted.
  private async bringUp(
    scope: OperationScope,
    options: {
      prepare?: () => Promise<void>
      readyHook: 'server:ready' | 'server:reload'
      onReady: () => void
      failMessage: string
    },
  ): Promise<void> {
    try {
      await options.prepare?.()
      scope.throwIfAborted()
      await this.startPlugins()
      scope.throwIfAborted()
      await this.syncHealthProbe()
      scope.throwIfAborted()
      await scope.wait(this.callServerHook('server:start'))
      await this.startRuntimes(scope)
      scope.throwIfAborted()
      await this.startProxy()
      scope.throwIfAborted()
      this.markSettled()
      await scope.wait(this.callServerHook(options.readyHook))
      options.onReady()
      this.logger.trace(this.getSnapshot(), 'Neem server snapshot')
    } catch (error) {
      // Aborted by stop(), which owns the cleanup from here.
      if (isOperationAborted(error)) throw error
      const normalized = normalizeError(error)
      this.markState('failed', normalized)
      this.logger.error({ err: normalized }, options.failMessage)
      await scope.wait(this.callServerFailHook(normalized))
      await this.stopSubsystems(this.createStopScope()).catch((stopError) => {
        this.logger.warn(
          new Error('Neem server cleanup after a failed start failed', {
            cause: normalizeError(stopError),
          }),
        )
      })
      throw normalized
    }
  }

  /** Rejects with OperationAbortedError when a stop interrupts it. */
  reloadRuntime(runtimeName: string, snapshot: RuntimeSnapshot): Promise<void> {
    return this.runOperation(async (scope) => {
      const reloadStartedAt = performance.now()
      const current = this.runtimes.get(runtimeName)
      let next: RuntimeController | undefined
      let detachProxyMs = 0
      let stopMs = 0
      let startMs = 0
      let attachProxyMs = 0
      let hooksMs = 0

      this.markState('reloading')
      this.logger.debug(`Neem runtime ${runtimeName} reloading`)
      this.logger.trace({ runtimeName }, 'Neem runtime reload options')

      try {
        if (current) {
          this.runtimes.delete(runtimeName)
          const detachProxyStartedAt = performance.now()
          // Once detached, stop() cannot reach this runtime, so this operation
          // finishes stopping it even when it is aborted.
          try {
            await this.syncProxyUpstreams()
            detachProxyMs = performance.now() - detachProxyStartedAt
          } finally {
            const stopStartedAt = performance.now()
            await current
              .stop(this.createStopScope())
              .catch((error) => this.reportUncleanStop(error))
            stopMs = performance.now() - stopStartedAt
          }
          scope.throwIfAborted()
        }

        this.replaceSnapshot(snapshot)

        if (snapshot.manifest.runtimes[runtimeName]) {
          const startStartedAt = performance.now()
          const created = this.createRuntime(runtimeName)
          next = created
          // Published before it starts so stop() reaches it.
          this.runtimes.set(runtimeName, created)
          await created.start(scope)
          startMs = performance.now() - startStartedAt
        }

        const attachProxyStartedAt = performance.now()
        await this.syncProxyUpstreams()
        scope.throwIfAborted()
        attachProxyMs = performance.now() - attachProxyStartedAt
        this.markSettled()
        const hooksStartedAt = performance.now()
        await scope.wait(
          callHostHook(this.hooks, this.snapshot.logger, 'runtime:reload', {
            mode: this.snapshot.mode,
            name: runtimeName,
            upstreams: this.runtimes.get(runtimeName)?.getUpstreams() ?? [],
          }),
        )
        hooksMs = performance.now() - hooksStartedAt
        this.logger.debug(`Neem runtime ${runtimeName} reloaded`)
        this.logger.debug(
          {
            runtimeName,
            totalMs: roundMs(performance.now() - reloadStartedAt),
            detachProxyMs: roundMs(detachProxyMs),
            stopMs: roundMs(stopMs),
            startMs: roundMs(startMs),
            attachProxyMs: roundMs(attachProxyMs),
            hooksMs: roundMs(hooksMs),
          },
          'Neem runtime reload timing',
        )
        this.logger.trace({ runtimeName }, 'Neem runtime reload result')
      } catch (error) {
        if (isOperationAborted(error)) throw error
        const normalized = normalizeError(error)
        this.runtimes.delete(runtimeName)
        await next?.stop(this.createStopScope()).catch(() => undefined)
        await this.syncProxyUpstreams().catch(() => undefined)
        this.markState('failed', normalized)
        this.logger.error(
          { err: normalized, runtimeName },
          `Failed to reload Neem runtime ${runtimeName}`,
        )
        await scope.wait(this.callServerFailHook(normalized))
      }
    })
  }

  /** Rejects with OperationAbortedError when a stop interrupts it. */
  applyPatch(
    runtimeName: string,
    updates: readonly BindingClientHmrUpdate[],
  ): Promise<RuntimePatchResult> {
    return this.runOperation(async (scope) => {
      const runtime = this.runtimes.get(runtimeName)
      if (!runtime) {
        return {
          outcome: 'rejected',
          deliveredFiles: [],
          reason: `Runtime [${runtimeName}] is not running`,
        }
      }
      // A patch can await replacement readiness inside a worker; stop() must
      // not wait for it, since stopping the runtime is what settles it.
      return scope.wait(runtime.applyPatch(updates))
    })
  }

  /**
   * Interrupts the operation in flight, joins it and stops every subsystem
   * within `lifecycle.stopTimeout`. Rejects with every cleanup error, including
   * workers or host runners terminated at the deadline; a stop requested while
   * one is running joins it, and one after the controller stopped is a no-op.
   */
  stop(scope?: OperationScope): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.state === 'stopped') return Promise.resolve()
    this.lifetime.abort()
    const stopping = this.runStop(scope ?? this.createStopScope()).finally(
      () => {
        this.stopping = undefined
        // Operations requested during this stop belong to the aborted
        // lifetime; a later start begins a new one.
        this.lifetime = new OperationScope()
      },
    )
    this.stopping = stopping
    return stopping
  }

  private async runStop(scope: OperationScope): Promise<void> {
    const errors: Error[] = []
    const collect = (error: unknown) => {
      errors.push(normalizeError(error))
    }
    const joined = await raceWithTimeout(
      this.operations.waitIdle(),
      scope.remaining(),
    )
    if (joined.timedOut) {
      errors.push(
        new Error(
          'Neem server operation did not settle before the stop deadline',
        ),
      )
    }

    this.markState('stopping')
    this.logger.info('Neem server stopping')
    await this.callServerHook('server:stop').catch(collect)
    await this.stopSubsystems(scope).catch(collect)
    this.markState('stopped')
    this.logger.debug('Neem server stopped')
    throwCollected(errors, 'Neem server did not stop cleanly')
  }

  // The lifetime is captured when the operation is requested, so one requested
  // before a stop never runs after it, even if the queue reaches it later.
  private runOperation<T>(
    run: (scope: OperationScope) => Promise<T>,
  ): Promise<T> {
    const lifetime = this.lifetime
    return this.operations.run(async () => {
      const scope = lifetime.child()
      try {
        scope.throwIfAborted()
        return await run(scope)
      } finally {
        scope.dispose()
      }
    })
  }

  // Ends a successful operation. A runtime that failed while it ran keeps the
  // server failed rather than being overwritten by the operation's success.
  private markSettled(): void {
    const failed = this.failOnWorkerError()
      ? [...this.runtimes.values()].find(
          (runtime) => runtime.getState() === 'failed',
        )
      : undefined
    if (failed) this.markState('failed', failed.getLastError())
    else this.markState('running')
  }

  private async startPlugins(): Promise<void> {
    const plugins = new PluginEnvironment({
      manifest: this.snapshot.manifest,
      outDir: this.snapshot.outDir,
      mode: this.snapshot.mode,
      logger: this.snapshot.logger,
      hooks: this.hooks,
      getHealth: () => this.getHealth(),
      cacheBust: this.snapshot.mode === 'development',
    })
    await plugins.initialize()
    this.plugins = plugins
  }

  private async startRuntimes(scope: OperationScope): Promise<void> {
    scope.throwIfAborted()
    const runtimes = new Map<string, RuntimeController>()
    for (const runtimeName of Object.keys(this.snapshot.manifest.runtimes)) {
      runtimes.set(runtimeName, this.createRuntime(runtimeName))
    }

    // Publish ownership before readiness so stop can reach starting workers;
    // a failure is cleaned up by bringUp, whose runtime stops join the
    // siblings that are still starting.
    this.runtimes = runtimes
    await Promise.all(
      [...runtimes.values()].map((runtime) => runtime.start(scope)),
    )
  }

  private async startProxy(): Promise<void> {
    if (!this.snapshot.config.proxy) return
    const proxy = new ProxyController(this.snapshot)
    await proxy.start(this.collectRuntimeUpstreams())
    this.proxy = proxy
  }

  private async syncProxyUpstreams(): Promise<void> {
    await this.proxy?.setUpstreams(this.collectRuntimeUpstreams())
  }

  private async syncHealthProbe(): Promise<void> {
    const config = this.snapshot.config.health
    if (this.healthProbe?.matches(config)) return

    await this.stopHealthProbe()
    if (!config) return

    const probe = new HealthProbe({
      config,
      logger: this.snapshot.logger,
      getHealth: () => this.getHealth(),
    })
    await probe.start()
    this.healthProbe = probe
  }

  // Runs every disposer even when an earlier one fails, then reports them all.
  private async stopSubsystems(scope: OperationScope): Promise<void> {
    const proxy = this.proxy
    const runtimes = [...this.runtimes.values()]
    const plugins = this.plugins
    this.proxy = undefined
    this.runtimes = new Map()
    this.plugins = undefined

    const errors: Error[] = []
    const collect = (error: unknown) => {
      errors.push(normalizeError(error))
    }
    await proxy?.stop().catch(collect)
    const results = await Promise.allSettled(
      runtimes.map((runtime) => runtime.stop(scope)),
    )
    for (const result of results) {
      if (result.status === 'rejected') collect(result.reason)
    }
    await this.stopHealthProbe().catch(collect)
    await plugins?.dispose().catch(collect)
    throwCollected(errors, 'Neem server subsystems did not stop cleanly')
  }

  private async stopHealthProbe(): Promise<void> {
    const probe = this.healthProbe
    this.healthProbe = undefined
    await probe?.stop()
  }

  private createRuntime(runtimeName: string): RuntimeController {
    const { prepareRecovery } = this.options
    return new RuntimeController({
      snapshot: this.snapshot,
      runtimeName,
      hooks: this.hooks,
      recovery: this.options.recovery,
      onThreadEvent: this.options.onThreadEvent,
      prepareRecovery: prepareRecovery && (() => prepareRecovery(runtimeName)),
      onRecovered: () => this.refreshProxyUpstreams(),
      onUpstreamsChange: () => this.refreshProxyUpstreams(),
      onFailure: (error) => {
        if (!this.failOnWorkerError()) return
        this.markState('failed', error)
        this.options.onFailure?.(error, runtimeName)
      },
    })
  }

  // A replaced generation is gone either way (anything that missed the
  // deadline was terminated), so its replacement still starts.
  private reportUncleanStop(error: unknown): void {
    this.logger.error(
      { err: normalizeError(error) },
      'Neem runtime did not stop cleanly before its replacement',
    )
  }

  private failOnWorkerError(): boolean {
    return this.options.failOnWorkerError ?? this.snapshot.mode === 'production'
  }

  private createStopScope(): OperationScope {
    const { stopTimeout } = resolveLifecycle(this.snapshot.config.lifecycle)
    return OperationScope.withTimeout(stopTimeout)
  }

  // Worker failure and recovery must not fail on proxy mutations; the proxy logs the
  // error, reports it in health, and retries the reconcile in the background.
  private async refreshProxyUpstreams(): Promise<void> {
    await this.proxy
      ?.setUpstreams(this.collectRuntimeUpstreams())
      .catch(() => undefined)
  }

  // Runtimes keep the snapshot they started from until they are reloaded, so
  // a recovery restarts a runtime from the same output as its siblings.
  private replaceSnapshot(snapshot: RuntimeSnapshot): void {
    this.snapshot = snapshot
    this.logger = childLogger(snapshot.logger, 'neem:server')
  }

  private collectRuntimeUpstreams(): readonly RuntimeUpstreams[] {
    return [...this.runtimes.values()].map((runtime) => ({
      runtimeName: runtime.name,
      upstreams: runtime.getUpstreams(),
    }))
  }

  private markState(state: NeemRuntimeServerState, error?: Error): void {
    const previousState = this.state
    this.state = state
    this.lastError = error
    this.revision++
    this.logger.debug(`Neem server state: ${previousState} -> ${state}`)
    this.logger.trace(
      { previousState, state, revision: this.revision, err: error },
      'Neem server state',
    )
  }

  private callServerHook(
    name:
      | 'server:start'
      | 'server:ready'
      | 'server:reload'
      | 'server:stop'
      | 'server:fail',
    error?: Error,
  ): Promise<void> {
    this.logger.trace({ hook: name, err: error }, 'Neem server hook')
    return callHostHook(this.hooks, this.logger, name, {
      mode: this.snapshot.mode,
      error,
    })
  }

  private async callServerFailHook(error: Error): Promise<void> {
    await this.callServerHook('server:fail', error).catch((failError) => {
      this.logger.warn(
        new Error('Neem server fail hook failed', {
          cause: normalizeError(failError),
        }),
      )
    })
  }

  private getDisabledProxyHealth(): NeemProxyHealth {
    return {
      enabled: Boolean(this.snapshot.config.proxy),
      running: false,
      ready: false,
      upstreams: [],
      appliedUpstreams: [],
      pending: 0,
      failedUpstreams: [],
    }
  }
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10
}
