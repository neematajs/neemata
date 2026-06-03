import { isBuiltin } from 'node:module'
import { dirname } from 'node:path'

import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'
import { createFuture } from '@nmtjs/common'
import * as rolldown from 'rolldown'

import type { NeemConfig } from '../../shared/types.ts'
import type { GraphWatcher, TargetChange } from '../build/compiler.ts'
import type { BuildTarget } from '../build/graph.ts'
import type { WatcherEvent } from './protocol.ts'
import { cleanNeemOutDir } from '../build/clean.ts'
import { watchGraph } from '../build/compiler.ts'
import { resolveNeemRuntimeDeclarations } from '../build/declarations.ts'
import { createBuildGraph } from '../build/graph.ts'
import { createManifest, writeManifest } from '../manifest/manifest.ts'
import { createLoggerFromConfigInput } from '../shared/logger.ts'
import { importDefault, serializeError } from '../shared/utils.ts'

export type WatcherServiceOptions = {
  configFile: string
  outDir: string
  runtimes?: readonly string[]
  emit: (event: WatcherEvent) => MaybePromise<void>
}

export class WatcherService {
  private graphWatcher: GraphWatcher | undefined
  private configWatcher: rolldown.RolldownWatcher | undefined
  private manifestFile: string | undefined
  private logger: Logger | undefined
  private stopped = false

  constructor(private readonly options: WatcherServiceOptions) {}

  async start(): Promise<string> {
    await cleanNeemOutDir(this.options.outDir)
    const config = await importDefault<NeemConfig>(this.options.configFile, {
      cacheBust: true,
    })
    this.logger = createLoggerFromConfigInput('development', config.logger)
    this.logger.info('Neem watcher starting')
    this.logger.trace(
      {
        configFile: this.options.configFile,
        outDir: this.options.outDir,
        runtimes: this.options.runtimes,
      },
      'Neem watcher options',
    )
    this.logger.trace({ config }, 'Neem source config')

    const resolvedConfig = await resolveNeemRuntimeDeclarations(
      this.options.configFile,
      config,
    )
    const graph = createBuildGraph({
      configFile: this.options.configFile,
      outDir: this.options.outDir,
      config: resolvedConfig,
      runtimes: this.options.runtimes,
    })
    this.logger.debug('Neem build graph ready')
    this.logger.trace(
      {
        runtimes: graph.runtimes.map((runtime) => runtime.name),
        plugins: graph.plugins.map((plugin) => plugin.name),
        targets: graph.targets.map(toLogTarget),
      },
      'Neem build graph',
    )

    this.configWatcher = await watchConfigSignal(this.options.configFile, () =>
      this.emit({ type: 'config-invalidated' }),
    )
    this.graphWatcher = await watchGraph(graph, {
      onChange: (change) => this.handleChange(change),
    })

    const compiled = await this.graphWatcher.ready
    this.manifestFile = await writeManifest(
      this.options.outDir,
      createManifest(compiled),
    )
    this.logger.info('Neem watcher ready')
    this.logger.trace(
      { manifestFile: this.manifestFile, targets: compiled.targets.length },
      'Neem watcher manifest',
    )
    await this.emit({ type: 'ready', manifestFile: this.manifestFile })
    return this.manifestFile
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.logger?.debug('Neem watcher stopping')
    const graphWatcher = this.graphWatcher
    const configWatcher = this.configWatcher
    this.graphWatcher = undefined
    this.configWatcher = undefined

    await Promise.all([graphWatcher?.close(), configWatcher?.close()])
    this.logger?.debug('Neem watcher stopped')
  }

  private async handleChange(change: TargetChange): Promise<void> {
    if (this.stopped || !this.graphWatcher) return

    try {
      const compiled = this.graphWatcher.snapshot()
      this.manifestFile = await writeManifest(
        this.options.outDir,
        createManifest(compiled),
      )
      const event = classifyChange(change)
      this.logger?.debug('Neem watcher rebuild applied')
      this.logger?.trace(
        {
          event,
          target: toLogTarget(change.target),
          manifestFile: this.manifestFile,
        },
        'Neem watcher rebuild',
      )
      await this.emit(event)
    } catch (error) {
      await this.emit({ type: 'error', error: serializeError(error) })
    }
  }

  private async emit(event: WatcherEvent): Promise<void> {
    if (!this.stopped) await this.options.emit(event)
  }
}

async function watchConfigSignal(
  configFile: string,
  onInvalidated: () => MaybePromise<void>,
): Promise<rolldown.RolldownWatcher> {
  const watcher = rolldown.watch({
    input: configFile,
    platform: 'node',
    logLevel: 'warn',
    external: (id) => isBuiltin(id),
    output: {
      file: `${dirname(configFile)}/.neem-config-signal.js`,
      minify: false,
      codeSplitting: false,
      sourcemap: false,
    },
    experimental: { chunkOptimization: false },
    optimization: { inlineConst: false, pifeForModuleWrappers: false },
    treeshake: false,
    watch: {
      buildDelay: 100,
      clearScreen: false,
      skipWrite: true,
      exclude: 'node_modules/**',
      watcher: { debounceDelay: 50, useDebounce: true },
    },
  })
  const ready = createFuture<void>()
  let initial = true

  watcher.on('event', async (event) => {
    if (event.code === 'ERROR') {
      ready.reject(event.error)
      if ('result' in event) await event.result?.close?.()
      return
    }

    if (event.code === 'BUNDLE_END' && 'result' in event) {
      await event.result?.close?.()
      return
    }

    if (event.code !== 'END') return
    if (initial) {
      initial = false
      ready.resolve()
      return
    }
    await onInvalidated()
  })

  await ready.promise
  return watcher
}

function classifyChange(change: TargetChange): WatcherEvent {
  switch (change.target.kind) {
    case 'runtime-worker':
    case 'runtime-planner':
      return { type: 'runtime-changed', runtimeName: getRuntimeName(change) }
    case 'runtime-host':
      return {
        type: 'runtime-host-changed',
        runtimeName: getRuntimeName(change),
      }
    case 'plugin-entry':
      return { type: 'plugin-changed' }
    case 'logger':
      return { type: 'logger-changed' }
    case 'start-entry':
    case 'worker-entry':
    case 'host-runner-entry':
      return { type: 'plugin-changed' }
  }
}

function getRuntimeName(change: TargetChange): string {
  const owner = change.target.owner
  return owner.type === 'runtime' ? owner.name : 'unknown'
}

function toLogTarget(target: BuildTarget) {
  return {
    key: target.key,
    kind: target.kind,
    owner: target.owner,
    artifactId: target.artifact.id,
    outDir: target.outDir,
  }
}
