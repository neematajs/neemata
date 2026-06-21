import * as module from 'node:module'
import { resolve } from 'node:path'

import { createFuture, OperationQueue } from '@nmtjs/common'
import { defineCommand } from 'citty'

import type {
  WorkerServiceStopCompleteEvent,
  WorkerServiceStopSlowEvent,
  WorkerServiceStopTimeoutEvent,
} from './internal/services/client.ts'
import type {
  RuntimeEvent,
  RuntimeResult,
  WatcherEvent,
  WatcherManifestIdentity,
  WatcherResult,
} from './internal/services/protocol.ts'
import type { NeemTestProbe } from './internal/test-probe.ts'
import { buildNeem } from './internal/commands/build.ts'
import { MANIFEST_FILE } from './internal/manifest/manifest.ts'
import {
  resolveServiceEntry,
  WorkerServiceClient,
} from './internal/services/client.ts'
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
      description: 'Output directory. Overrides config outDir.',
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
    outDir: {
      type: 'string',
      description: 'Built output directory.',
      default: 'dist',
    },
    runtime: {
      type: 'positional',
      description: 'Comma-separated runtime names to start.',
      required: false,
    },
  },
  async run({ args }) {
    const cwd = process.cwd()
    const outDir = resolve(cwd, args.outDir)
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
        id: 0,
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
      description: 'Development output directory.',
      default: '.neem',
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
  },
  async run({ args }) {
    if (args.cache && 'enableCompileCache' in module) {
      const { status, directory } = module.enableCompileCache({
        directory: args.cacheDir,
      })
      if (status === module.constants.compileCacheStatus.ENABLED) {
        process.env.NODE_COMPILE_CACHE = directory
        console.log(`Node.js compile cache enabled at ${directory}`)
      }
    }
    const controller = createCliAbortController()
    const supervisor = new DevSupervisor({
      configFile: resolve(process.cwd(), args.config),
      outDir: resolve(process.cwd(), args.outDir),
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
  private runtime: RuntimeClient | undefined
  private manifestFile: string | undefined
  private manifestRevision = 0
  private stopped = false

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

  async stop(): Promise<void> {
    if (this.stopped && !this.watcher && !this.runtime) return
    this.stopped = true
    await this.events.waitIdle()
    const watcher = this.watcher
    const runtime = this.runtime
    this.watcher = undefined
    this.runtime = undefined
    await Promise.all([watcher?.stop(), runtime?.stop()])
    this.options.probe?.emit('cli:dev:closed')
    this.closedFuture.resolve()
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
    const result = await watcher.request({
      id: 0,
      type: 'start',
      configFile: this.options.configFile,
      outDir: this.options.outDir,
      runtimes: this.options.runtimes,
    })
    if (result?.manifestFile) this.manifestFile = result.manifestFile
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

    try {
      await this.startWatcher()
    } catch (error) {
      const failedWatcher = this.watcher
      this.watcher = previousWatcher
      await failedWatcher?.stop().catch(() => undefined)
      this.reportWatcherError(error)
      return
    }

    if (previousWatcher && previousWatcher !== this.watcher) {
      await previousWatcher.stop()
    }
  }

  private reportWatcherError(error: unknown): void {
    this.options.probe?.emit(
      'watcher:error',
      normalizeEvent({ type: 'error', error: serializeError(error) }),
    )
  }

  private async restartRuntime(): Promise<void> {
    if (!this.manifestFile) return
    await this.stopRuntime()
    const runtime = createRuntimeClient({
      probe: this.options.probe,
      onEvent: (event) => {
        this.options.probe?.emit(`runtime:${event.type}`, normalizeEvent(event))
        if (event.type === 'error') {
          this.closedFuture.reject(deserializeError(event.error))
        }
      },
      onFailure: (error) => this.closedFuture.reject(error),
    })
    this.runtime = runtime
    await runtime.request({
      id: 0,
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
      id: 0,
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

function createWatcherClient(options: {
  probe?: NeemTestProbe
  onEvent: (event: WatcherEvent) => void
  onFailure: (error: Error) => void
}): WatcherClient {
  return new WorkerServiceClient<WatcherEvent, WatcherResult>({
    entry: resolveServiceEntry('watcher-entry'),
    serviceName: 'watcher',
    onStopComplete: (event) => reportServiceStopComplete(options.probe, event),
    onStopSlow: (event) => reportServiceStopSlow(options.probe, event),
    onStopTimeout: (event) => reportServiceStopTimeout(options.probe, event),
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
    onStopComplete: (event) => reportServiceStopComplete(options.probe, event),
    onStopSlow: (event) => reportServiceStopSlow(options.probe, event),
    onStopTimeout: (event) => reportServiceStopTimeout(options.probe, event),
    ...options,
  })
}

function reportServiceStopSlow(
  probe: NeemTestProbe | undefined,
  event: WorkerServiceStopSlowEvent,
): void {
  probe?.emit('service:stop-slow', event)
  process.stderr.write(
    `Neem ${event.serviceName} service worker still stopping after ${event.elapsedMs}ms\n`,
  )
}

function reportServiceStopComplete(
  probe: NeemTestProbe | undefined,
  event: WorkerServiceStopCompleteEvent,
): void {
  probe?.emit('service:stop-complete', event)
  const action = event.exited ? 'stopped' : 'did not stop'
  process.stderr.write(
    `Neem ${event.serviceName} service worker ${action} after ${event.elapsedMs}ms\n`,
  )
}

function reportServiceStopTimeout(
  probe: NeemTestProbe | undefined,
  event: WorkerServiceStopTimeoutEvent,
): void {
  probe?.emit('service:stop-timeout', event)
  process.stderr.write(
    `Neem ${event.serviceName} service stop timed out after ${event.timeoutMs}ms; terminating worker\n`,
  )
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
