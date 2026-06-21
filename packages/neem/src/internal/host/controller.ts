import { performance } from 'node:perf_hooks'

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
import { childLogger } from '../logger.ts'
import { PluginEnvironment } from '../plugins/environment.ts'
import { callHostHook, createHostHooks } from '../plugins/hooks.ts'
import { normalizeError } from '../utils.ts'
import { HealthProbe } from './health.ts'
import { ProxyController } from './proxy.ts'
import { RuntimeController } from './runtime.ts'

export type HostControllerOptions = {
  snapshot: RuntimeSnapshot
  hooks?: HostHooks
  failOnWorkerError?: boolean
  recovery?: RecoveryOptions
  onFailure?: (error: Error) => void
}

export class HostController {
  private state: NeemRuntimeServerState = 'idle'
  private revision = 0
  private lastError: Error | undefined
  private snapshot: RuntimeSnapshot
  private logger: RuntimeSnapshot['logger']
  private readonly hooks: HostHooks
  private readonly operations = new OperationQueue()
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

  start(): Promise<void> {
    return this.operations.run(async () => {
      if (this.state === 'running') return
      this.markState('starting')
      this.logger.info('Neem server starting')
      this.logger.trace(
        {
          mode: this.snapshot.mode,
          runtimes: Object.keys(this.snapshot.manifest.runtimes),
          outDir: this.snapshot.outDir,
        },
        'Neem server options',
      )
      this.logger.trace(
        { config: this.snapshot.manifest.config },
        'Neem manifest config',
      )

      try {
        await this.startPlugins()
        await this.syncHealthProbe()
        await this.callServerHook('server:start')
        await this.startRuntimes()
        await this.startProxy()
        this.markState('running')
        await this.callServerHook('server:ready')
        this.logger.info('Neem server ready')
        this.logger.trace(this.getLogSnapshot(), 'Neem server snapshot')
      } catch (error) {
        const normalized = normalizeError(error)
        this.markState('failed', normalized)
        this.logger.error({ err: normalized }, 'Failed to start Neem server')
        await this.callServerFailHook(normalized)
        await this.stopSubsystems().catch(() => undefined)
        throw normalized
      }
    })
  }

  reload(snapshot: RuntimeSnapshot): Promise<void> {
    return this.operations.run(async () => {
      this.markState('reloading')
      this.logger.debug('Neem server reloading')
      this.logger.trace(
        {
          mode: snapshot.mode,
          runtimes: Object.keys(snapshot.manifest.runtimes),
          outDir: snapshot.outDir,
        },
        'Neem server options',
      )
      this.logger.trace(
        { config: snapshot.manifest.config },
        'Neem manifest config',
      )

      try {
        await this.stopSubsystems()
        this.replaceSnapshot(snapshot)
        await this.startPlugins()
        await this.syncHealthProbe()
        await this.callServerHook('server:start')
        await this.startRuntimes()
        await this.startProxy()
        this.markState('running')
        await this.callServerHook('server:reload')
        this.logger.debug('Neem server reloaded')
        this.logger.trace(this.getLogSnapshot(), 'Neem server snapshot')
      } catch (error) {
        const normalized = normalizeError(error)
        this.markState('failed', normalized)
        this.logger.error({ err: normalized }, 'Failed to reload Neem server')
        await this.callServerFailHook(normalized)
        await this.stopSubsystems().catch(() => undefined)
        throw normalized
      }
    })
  }

  reloadRuntime(runtimeName: string, snapshot: RuntimeSnapshot): Promise<void> {
    return this.operations.run(async () => {
      const reloadStartedAt = performance.now()
      const current = this.runtimes.get(runtimeName)
      let currentDetached = false
      let currentStopped = false
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
          currentDetached = true
          const detachProxyStartedAt = performance.now()
          await this.syncProxyUpstreams()
          detachProxyMs = performance.now() - detachProxyStartedAt
          const stopStartedAt = performance.now()
          await current.stop()
          stopMs = performance.now() - stopStartedAt
          currentStopped = true
        }

        this.replaceSnapshot(snapshot)

        const exists = Boolean(snapshot.manifest.runtimes[runtimeName])
        if (exists) {
          const startStartedAt = performance.now()
          next = this.createRuntime(runtimeName)
          this.runtimes.set(runtimeName, next)
          await next.start()
          startMs = performance.now() - startStartedAt
        }

        const attachProxyStartedAt = performance.now()
        await this.syncProxyUpstreams()
        attachProxyMs = performance.now() - attachProxyStartedAt
        this.markState('running')
        const hooksStartedAt = performance.now()
        await callHostHook(this.hooks, this.snapshot.logger, 'runtime:reload', {
          mode: this.snapshot.mode,
          name: runtimeName,
          upstreams: this.runtimes.get(runtimeName)?.getUpstreams() ?? [],
        })
        hooksMs = performance.now() - hooksStartedAt
        this.logger.debug(`Neem runtime ${runtimeName} reloaded`)
        this.logger.warn(
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
        const normalized = normalizeError(error)
        this.runtimes.delete(runtimeName)
        if (currentDetached && !currentStopped) {
          await current?.stop().catch(() => undefined)
        }
        await next?.stop().catch(() => undefined)
        await this.syncProxyUpstreams().catch(() => undefined)
        this.markState('failed', normalized)
        this.logger.error(
          { err: normalized, runtimeName },
          `Failed to reload Neem runtime ${runtimeName}`,
        )
        await this.callServerFailHook(normalized)
      }
    })
  }

  stop(): Promise<void> {
    return this.operations.run(async () => {
      if (this.state === 'stopped') return
      this.markState('stopping')
      this.logger.info('Neem server stopping')

      let stopError: Error | undefined
      try {
        await this.callServerHook('server:stop').catch((error) => {
          stopError = normalizeError(error)
        })
        await this.stopSubsystems().catch((error) => {
          stopError ??= normalizeError(error)
        })
      } finally {
        this.markState('stopped')
        this.logger.info('Neem server stopped')
      }

      if (stopError) throw stopError
    })
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

  private async startRuntimes(): Promise<void> {
    const runtimes = new Map<string, RuntimeController>()
    for (const runtimeName of Object.keys(this.snapshot.manifest.runtimes)) {
      runtimes.set(runtimeName, this.createRuntime(runtimeName))
    }

    try {
      await Promise.all(
        [...runtimes.values()].map((runtime) => runtime.start()),
      )
      this.runtimes = runtimes
    } catch (error) {
      await Promise.allSettled(
        [...runtimes.values()].map((runtime) => runtime.stop()),
      )
      throw error
    }
  }

  private async startProxy(): Promise<void> {
    if (!this.snapshot.config.proxy) return
    const proxy = new ProxyController(this.snapshot)
    await proxy.start(this.collectRuntimeUpstreams())
    this.proxy = proxy
  }

  private async syncProxyUpstreams(): Promise<void> {
    await this.proxy?.setUpstreams(this.collectRuntimeUpstreams())
    await this.proxy?.waitForIdle()
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

  private async stopSubsystems(): Promise<void> {
    const proxy = this.proxy
    const runtimes = [...this.runtimes.values()]
    const plugins = this.plugins
    this.proxy = undefined
    this.runtimes.clear()
    this.plugins = undefined

    await proxy?.stop()
    await Promise.allSettled(runtimes.map((runtime) => runtime.stop()))
    await this.stopHealthProbe()
    await plugins?.dispose()
  }

  private async stopHealthProbe(): Promise<void> {
    const probe = this.healthProbe
    this.healthProbe = undefined
    await probe?.stop()
  }

  private createRuntime(runtimeName: string): RuntimeController {
    return new RuntimeController({
      snapshot: this.snapshot,
      runtimeName,
      hooks: this.hooks,
      recovery: this.options.recovery,
      onRecovered: async () => {
        await this.proxy?.setUpstreams(this.collectRuntimeUpstreams())
      },
      onFailure: (error) => {
        const failOnWorkerError =
          this.options.failOnWorkerError ?? this.snapshot.mode === 'production'
        if (!failOnWorkerError) return
        this.markState('failed', error)
        this.options.onFailure?.(error)
      },
    })
  }

  private replaceSnapshot(snapshot: RuntimeSnapshot): void {
    this.snapshot = snapshot
    this.logger = childLogger(snapshot.logger, 'neem:server')
    for (const runtime of this.runtimes.values())
      runtime.replaceSnapshot(snapshot)
  }

  private collectRuntimeUpstreams(): readonly RuntimeUpstreams[] {
    return [...this.runtimes.values()].map((runtime) => ({
      runtimeName: runtime.name,
      upstreams: runtime.getUpstreams(),
    }))
  }

  private getLogSnapshot() {
    const { artifactCount, ...snapshot } = this.getSnapshot()
    return { ...snapshot, runtimeArtifactCount: artifactCount }
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
    name: 'server:start' | 'server:ready' | 'server:reload' | 'server:stop',
  ): Promise<void>
  private callServerHook(name: 'server:fail', error: Error): Promise<void>
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
