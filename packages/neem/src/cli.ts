import * as module from 'node:module'
import { resolve } from 'node:path'

// dotenvx is CommonJS; since 2.30.0 Node no longer detects its named exports.
import dotenvx from '@dotenvx/dotenvx'
import { createFuture, OperationQueue } from '@nmtjs/common'
import { defineCommand } from 'citty'

import type { WorkerServiceStopProgressEvent } from './internal/services/client.ts'
import type { ConfigSignalWatcher } from './internal/services/config-signal.ts'
import type {
  RuntimeEvent,
  RuntimeResult,
  WatcherEvent,
  WatcherManifestIdentity,
  WatcherResult,
} from './internal/services/protocol.ts'
import type { NeemTestProbe } from './internal/test-probe.ts'
import { buildNeem } from './internal/commands/build.ts'
import {
  resolveDevOutDir,
  resolveStartOutDir,
} from './internal/commands/out-dir.ts'
import {
  childLogger,
  createDefaultLogger,
  resolveManifestLogger,
} from './internal/logger.ts'
import { MANIFEST_FILE, readManifest } from './internal/manifest/manifest.ts'
import {
  resolveServiceEntry,
  WorkerServiceClient,
} from './internal/services/client.ts'
import { watchConfigSignal } from './internal/services/config-signal.ts'
import { createNeemTestProbe } from './internal/test-probe.ts'
import {
  deserializeError,
  normalizeError,
  serializeError,
} from './internal/utils.ts'

type RuntimeClient = WorkerServiceClient<RuntimeEvent, RuntimeResult>
type WatcherClient = WorkerServiceClient<WatcherEvent, WatcherResult>

export const buildCommand = defineCommand({
  meta: {
    name: 'build',
    description: 'Build Neem config and runtime artifacts.',
  },
  args: {
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to build.',
      required: false,
    },
    config: {
      type: 'string',
      description: 'Path to neem.config file.',
      default: 'neem.config.ts',
    },
    outDir: {
      type: 'string',
      description:
        'Output directory relative to cwd. Overrides config outDir, which resolves from the config file (default: dist).',
    },
  },
  async run({ args }) {
    const probe = createNeemTestProbe()
    probe?.emit('cli:build:start')
    await buildNeem({
      config: args.config,
      outDir: args.outDir,
      runtimes: parseRuntimes(args.runtime),
    })
    probe?.emit('cli:build:closed')
  },
})

export const startCommand = defineCommand({
  meta: { name: 'start', description: 'Start a built Neem runtime server.' },
  args: {
    config: {
      type: 'string',
      description:
        'Path to neem.config file. Starts its outDir; evaluates the config.',
    },
    outDir: {
      type: 'string',
      description:
        'Built output directory relative to cwd. Overrides --config (default: dist).',
    },
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to start.',
      required: false,
    },
  },
  async run({ args }) {
    const outDir = await resolveStartOutDir({
      cwd: process.cwd(),
      config: args.config,
      outDir: args.outDir,
    })
    const manifestFile = resolve(outDir, MANIFEST_FILE)
    const probe = createNeemTestProbe()
    const controller = createCliAbortController()
    const closed = createFuture<void>()
    closed.promise.catch(() => {})
    probe?.emit('cli:start:start')

    const runtime = createRuntimeClient({
      probe,
      onEvent(event) {
        probe?.emit(`runtime:${event.type}`, normalizeEvent(event))
        if (event.type === 'stopped') closed.resolve()
        if (event.type === 'error') closed.reject(deserializeError(event.error))
      },
      onFailure(error) {
        closed.reject(error)
      },
    })

    controller.signal.addEventListener(
      'abort',
      () => {
        void runtime.stop().then(
          () => closed.resolve(),
          (error) => closed.reject(normalizeError(error)),
        )
      },
      { once: true },
    )

    try {
      await runtime.request({
        type: 'start',
        mode: 'production',
        outDir,
        manifestFile,
        runtimes: parseRuntimes(args.runtime),
      })
      await closed.promise
      probe?.emit('cli:start:closed')
    } finally {
      controller.dispose()
      await runtime.stop().catch(() => undefined)
    }
  },
})

export const devCommand = defineCommand({
  meta: {
    name: 'dev',
    description: 'Start a watched Neem development server.',
  },
  args: {
    config: {
      type: 'string',
      description: 'Path to neem.config file.',
      default: 'neem.config.ts',
    },
    outDir: {
      type: 'string',
      description:
        'Development output directory relative to cwd (default: .neem/<config name> next to the config).',
    },
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to start in dev.',
      required: false,
    },
    cache: {
      type: 'boolean',
      description: 'Enable Node.js compile cache',
      default: true,
    },
    cacheDir: {
      type: 'string',
      description: 'Directory for Node.js compile cache',
    },
    'env-files': {
      type: 'string',
      description:
        'Comma-separated env files relative to cwd. Existing variables and earlier files take precedence.',
    },
  },
  async run({ args }) {
    if (args['env-files'] !== undefined) {
      const paths = args['env-files'].split(',').map((path) => path.trim())
      if (paths.some((path) => !path)) {
        throw new Error('--env-files requires non-empty file paths')
      }
      // Load before spawning services so config evaluation and runtime workers inherit the values.
      dotenvx.config({ path: paths, quiet: true, strict: true })
    }
    if (args.cache && 'enableCompileCache' in module) {
      const result = module.enableCompileCache({ directory: args.cacheDir })
      if (result && typeof result === 'object') {
        const { status, directory } = result
        if (status === module.constants.compileCacheStatus.ENABLED) {
          process.env.NODE_COMPILE_CACHE = directory
          console.log(`Node.js compile cache enabled at ${directory}`)
        }
      }
    }
    const cwd = process.cwd()
    const configFile = resolve(cwd, args.config)
    const controller = createCliAbortController()
    const supervisor = new DevSupervisor({
      configFile,
      outDir: resolveDevOutDir({ cwd, configFile, outDir: args.outDir }),
      runtimes: parseRuntimes(args.runtime),
      signal: controller.signal,
      probe: createNeemTestProbe(),
    })

    try {
      await supervisor.start()
      await supervisor.closed
    } finally {
      controller.dispose()
      await supervisor.stop().catch(() => undefined)
    }
  },
})

export const mainCommand = defineCommand({
  meta: { name: 'neem', description: 'Neem host CLI.' },
  subCommands: { build: buildCommand, dev: devCommand, start: startCommand },
})

type DevSupervisorOptions = {
  configFile: string
  outDir: string
  runtimes?: readonly string[]
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
  // Runtimes whose worker output on disk predates their running generation.
  private readonly staleWorkers = new Set<string>()
  // Restarts that found a stale worker failing to build. They wait for its next
  // successful build rather than load output older than the running generation.
  private readonly deferredReloads = new Set<string>()
  private readonly deferredRecoveries = new Set<string>()
  private restartDeferred = false
  private logger = childLogger(
    createDefaultLogger('development'),
    'neem:server',
  )
  private stopped = false
  private stopping: Promise<void> | undefined

  constructor(private readonly options: DevSupervisorOptions) {
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
    // A watcher event may be awaiting runtime readiness. Deliver stop before
    // draining that queue so a pending start can finish its own cleanup.
    const runtime = this.stopRuntime()
    return (this.stopping = (async () => {
      await Promise.all([runtime, this.events.waitIdle()])
      const watcher = this.watcher
      const configSignalWatcher = this.configSignalWatcher
      this.watcher = undefined
      this.configSignalWatcher = undefined
      await Promise.all([configSignalWatcher?.close(), watcher?.stop()])
      this.options.probe?.emit('cli:dev:closed')
      this.closedFuture.resolve()
    })())
  }

  private async startWatcher(): Promise<void> {
    if (this.stopped) return
    const watcher = createWatcherClient({
      probe: this.options.probe,
      onEvent: (event) => {
        this.options.probe?.emit(`watcher:${event.type}`, normalizeEvent(event))
        void this.events
          .run(() => this.handleWatcherEvent(event))
          .catch((error) => {
            this.closedFuture.reject(normalizeError(error))
          })
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
    await this.stopRuntime()
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
    void this.events
      .run(() => this.handleWatcherEvent(event))
      .catch((error) => {
        this.closedFuture.reject(normalizeError(error))
      })
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
    this.logger = childLogger(
      await resolveManifestLogger(manifest.config.logger, {
        mode: 'development',
        outDir: this.options.outDir,
      }),
      'neem:server',
    )
    await this.stopRuntime()
    if (this.stopped) return false
    const runtime = createRuntimeClient({
      probe: this.options.probe,
      onEvent: (event) => {
        this.options.probe?.emit(`runtime:${event.type}`, normalizeEvent(event))
        if (event.type === 'error') {
          this.closedFuture.reject(deserializeError(event.error))
        }
        if (
          event.type === 'thread-started' ||
          event.type === 'thread-stopped'
        ) {
          void this.events
            .run(() => this.handleThreadEvent(event))
            .catch((error) => {
              this.closedFuture.reject(normalizeError(error))
            })
        }
        if (event.type === 'runtime-recovering') {
          void this.events
            .run(() => this.prepareRecovery(event.runtimeName))
            .catch((error) => {
              this.closedFuture.reject(normalizeError(error))
            })
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
    return true
  }

  private async reloadRuntime(runtimeName: string): Promise<boolean> {
    if (!this.runtime || !this.manifestFile) return false
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
    await this.runtime.request({
      type: 'reload-runtime',
      runtimeName,
      manifestFile: this.manifestFile,
    })
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

  // Host recovery restarts a crashed runtime from the files on disk, so it
  // waits here until they include every patch the crashed threads accepted.
  private async prepareRecovery(runtimeName: string): Promise<boolean> {
    if (this.stopped || !this.runtime) return false
    if (
      this.staleWorkers.has(runtimeName) &&
      !(await this.refreshWorkerOutput(runtimeName))
    ) {
      this.deferredRecoveries.add(runtimeName)
      this.reportRestartDeferred(runtimeName)
      return false
    }
    this.deferredRecoveries.delete(runtimeName)
    await this.runtime.request({ type: 'recovery-output-ready', runtimeName })
    return true
  }

  private async handleThreadEvent(
    event: Extract<RuntimeEvent, { threadId: string }>,
  ): Promise<void> {
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
      const result = await this.runtime?.request({
        type: 'apply-patch',
        runtimeName,
        updates,
      })
      const patch = result?.patch
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

  private async stopRuntime(): Promise<void> {
    const runtime = this.runtime
    this.runtime = undefined
    await runtime?.stop()
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

function createRuntimeClient(options: {
  probe?: NeemTestProbe
  onEvent: (event: RuntimeEvent) => void
  onFailure: (error: Error) => void
}): RuntimeClient {
  return new WorkerServiceClient<RuntimeEvent, RuntimeResult>({
    entry: resolveServiceEntry('runtime-entry'),
    serviceName: 'runtime',
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

function parseRuntimes(runtime?: string): string[] | undefined {
  if (!runtime) return undefined
  const runtimes = runtime
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  return runtimes.length > 0 ? [...new Set(runtimes)] : undefined
}

function createCliAbortController() {
  const controller = new AbortController()
  const abort = () => controller.abort()

  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)

  return {
    signal: controller.signal,
    dispose() {
      process.off('SIGINT', abort)
      process.off('SIGTERM', abort)
    },
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
