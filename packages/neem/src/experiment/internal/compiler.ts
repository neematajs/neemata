import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { MaybePromise } from '@nmtjs/common'
import type { OutputOptions, RolldownOutput } from 'rolldown'
import type {
  BindingClientHmrUpdate,
  DevEngine,
  DevOptions,
} from 'rolldown/experimental'
import { createFuture } from '@nmtjs/common'
import { dev } from 'rolldown/experimental'

import type {
  ArtifactBuildMetadata,
  CompiledGraph,
  CompiledTarget,
  TargetChange,
  TargetWatcher,
} from '../../internal/build/compiler.ts'
import type { BuildGraph, BuildTarget } from '../../internal/build/graph.ts'
import type { NeemBuildWatchConfig } from '../../shared/types.ts'
import {
  createCompiledGraph,
  createResolvedArtifact,
  createRolldownOptions,
  watchBuildGroup,
} from '../../internal/build/compiler.ts'
import { toFilePath } from '../../internal/utils.ts'
import { NEEM_HMR_IMPLEMENTATION } from './dev-runtime.ts'

export type TargetHmrUpdate = {
  target: BuildTarget
} & (
  | {
      updates: readonly BindingClientHmrUpdate[]
      changedFiles: readonly string[]
      error?: never
      requiresFallback?: never
    }
  | {
      error: Error
      requiresFallback: boolean
      updates?: never
      changedFiles?: never
    }
)

export type TargetHmrController = {
  syncClients: (clientIds: readonly string[]) => Promise<void>
  notifyPayloadDelivered: (filename: string) => Promise<void>
  ensureLatestBuildOutput: () => Promise<void>
}

export type GraphWatcher = {
  ready: Promise<CompiledGraph>
  snapshot: () => CompiledGraph
  close: () => Promise<void>
  syncHmrClients: (
    runtimeName: string,
    clientIds: readonly string[],
  ) => Promise<void>
  notifyHmrPayloadDelivered: (
    runtimeName: string,
    filename: string,
  ) => Promise<void>
  ensureLatestHmrOutput: (runtimeName: string) => Promise<void>
}

type ExperimentalTargetWatcher = TargetWatcher & {
  hmr: TargetHmrController
}

type BuildGroupWatcher = {
  target?: BuildTarget
  ready: Promise<readonly CompiledTarget[]>
  close: () => Promise<void>
  hmr?: TargetHmrController
}

export async function watchGraph(
  graph: BuildGraph,
  handlers: {
    onChange?: (change: TargetChange) => MaybePromise<void>
    onHmrUpdate?: (update: TargetHmrUpdate) => MaybePromise<void>
  } = {},
): Promise<GraphWatcher> {
  const compiled = new Map<string, CompiledTarget>()
  const watchConfig = graph.config.build?.watch
  const watchers = await Promise.all(
    graph.buildGroups.map(async (group): Promise<BuildGroupWatcher> => {
      const onRebuild = async (change: TargetChange) => {
        for (const target of change.compiledTargets ?? [change.compiled]) {
          compiled.set(target.target.key, target)
        }
        await handlers.onChange?.(change)
      }
      if (group.kind !== 'target' || group.target.kind !== 'runtime-worker') {
        return watchBuildGroup(
          group,
          { onRebuild },
          watchConfig,
          group.kind === 'infra' ? 'bootstrap' : 'disabled',
        )
      }

      const watcher = await watchExperimentalTarget(
        group.target,
        { onRebuild, onHmrUpdate: handlers.onHmrUpdate },
        watchConfig,
      )
      return {
        target: group.target,
        ready: watcher.ready.then((target) => [target]),
        close: watcher.close,
        hmr: watcher.hmr,
      }
    }),
  )
  const hmrByRuntime = new Map<string, TargetHmrController>()
  for (const watcher of watchers) {
    const owner = watcher.target?.owner
    if (watcher.hmr && owner?.type === 'runtime') {
      hmrByRuntime.set(owner.name, watcher.hmr)
    }
  }
  const ready = Promise.all(watchers.map((watcher) => watcher.ready)).then(
    (groups) => {
      const targets = groups.flat()
      for (const target of targets) compiled.set(target.target.key, target)
      return createCompiledGraph(graph, targets)
    },
  )

  return {
    ready,
    snapshot() {
      return createCompiledGraph(graph, [...compiled.values()])
    },
    async close() {
      await Promise.all(watchers.map((watcher) => watcher.close()))
    },
    async syncHmrClients(runtimeName, clientIds) {
      await hmrByRuntime.get(runtimeName)?.syncClients(clientIds)
    },
    async notifyHmrPayloadDelivered(runtimeName, filename) {
      await hmrByRuntime.get(runtimeName)?.notifyPayloadDelivered(filename)
    },
    async ensureLatestHmrOutput(runtimeName) {
      await hmrByRuntime.get(runtimeName)?.ensureLatestBuildOutput()
    },
  }
}

async function watchExperimentalTarget(
  target: BuildTarget,
  handlers: {
    onRebuild?: (change: TargetChange) => MaybePromise<void>
    onHmrUpdate?: (update: TargetHmrUpdate) => MaybePromise<void>
  } = {},
  watchConfig?: NeemBuildWatchConfig,
): Promise<ExperimentalTargetWatcher> {
  const metadata: ArtifactBuildMetadata = { watch: true }
  const ready = createFuture<CompiledTarget>()
  let initialOutput = true
  let engine: DevEngine | undefined
  let clients = new Set<string>()

  await mkdir(target.outDir, { recursive: true })
  const input = createExperimentalRolldownOptions(target, metadata)
  const output = input.output as OutputOptions | undefined
  delete input.output

  engine = await dev(input, output, {
    rebuildStrategy: 'never',
    watch: createDevWatchOptions(watchConfig),
    onOutput: async (result) => {
      if (result instanceof Error) {
        if (initialOutput) ready.reject(result)
        else {
          await handlers.onHmrUpdate?.({
            target,
            error: result,
            requiresFallback: false,
          })
        }
        return
      }

      const compiled = {
        target,
        artifact: createResolvedArtifact(target, result, metadata),
      }
      if (initialOutput) {
        initialOutput = false
        ready.resolve(compiled)
        return
      }
      await handlers.onRebuild?.({ target, compiled, initial: false })
    },
    onAdditionalAssets: (result) => writeRolldownOutput(target.outDir, result),
    onHmrUpdates: async (result) => {
      if (result instanceof Error) {
        await handlers.onHmrUpdate?.({
          target,
          error: result,
          requiresFallback: true,
        })
        return
      }
      await Promise.all(
        result.updates.flatMap(({ update }) =>
          update.type === 'Patch' ? [writeHmrPatch(target.outDir, update)] : [],
        ),
      )
      await handlers.onHmrUpdate?.({ target, ...result })
    },
  })
  try {
    await engine.run()
    await ready.promise
  } catch (error) {
    const current = engine
    engine = undefined
    clients.clear()
    await current.close().catch(() => undefined)
    throw error
  }

  return {
    target,
    ready: ready.promise,
    hmr: {
      async syncClients(clientIds) {
        if (!engine) return
        const current = engine
        // A replacement worker needs a fresh ship map even when its logical
        // Neem thread id is unchanged.
        await Promise.all([...clients].map((id) => current.removeClient(id)))
        clients = new Set(clientIds)
        await Promise.all([...clients].map((id) => current.registerClient(id)))
      },
      async notifyPayloadDelivered(filename) {
        await engine?.notifyPayloadDelivered(filename)
      },
      async ensureLatestBuildOutput() {
        await engine?.ensureLatestBuildOutput()
      },
    },
    async close() {
      const current = engine
      engine = undefined
      clients.clear()
      await current?.close()
    },
  }
}

function createExperimentalRolldownOptions(
  target: BuildTarget,
  metadata: ArtifactBuildMetadata,
) {
  const options = createRolldownOptions(target, metadata, 'runtime')
  const plugins = options.plugins
  options.experimental = {
    ...options.experimental,
    devMode: { implement: NEEM_HMR_IMPLEMENTATION, lazy: false },
  }
  options.plugins = [
    ...normalizePlugins(plugins),
    createHmrBoundaryPlugin(toFilePath(target.artifact.entry)),
  ]
  return options
}

function createDevWatchOptions(
  config: NeemBuildWatchConfig | undefined,
): NonNullable<DevOptions['watch']> {
  return {
    skipWrite: false,
    useDebounce: true,
    debounceDuration: config?.debounceDelay ?? 50,
  }
}

function createHmrBoundaryPlugin(
  entry: string,
): import('rolldown').RolldownPlugin {
  return {
    name: 'neem:experimental-dev-boundary',
    transform: {
      filter: { id: entry },
      handler(code) {
        // The worker definition is Neem's semantic replacement boundary; leaf
        // modules deliberately bubble here instead of accepting themselves.
        return `${code}\nif (import.meta.hot) {\n  import.meta.hot.accept((module) => globalThis.__neem_accept_worker__?.(module.default))\n}\n`
      },
    },
  }
}

async function writeHmrPatch(
  outDir: string,
  patch: Extract<BindingClientHmrUpdate['update'], { type: 'Patch' }>,
): Promise<void> {
  await writeOutputFile(outDir, patch.filename, patch.code)
  if (patch.sourcemap && patch.sourcemapFilename) {
    await writeOutputFile(outDir, patch.sourcemapFilename, patch.sourcemap)
  }
}

async function writeRolldownOutput(
  outDir: string,
  output: RolldownOutput,
): Promise<void> {
  await Promise.all(
    output.output.map((item) =>
      writeOutputFile(
        outDir,
        item.fileName,
        item.type === 'asset' ? item.source : item.code,
      ),
    ),
  )
}

async function writeOutputFile(
  outDir: string,
  filename: string,
  content: string | Uint8Array,
): Promise<void> {
  const file = resolve(outDir, filename)
  const pathFromOutput = relative(outDir, file)
  if (
    pathFromOutput === '..' ||
    pathFromOutput.startsWith(`..${sep}`) ||
    isAbsolute(pathFromOutput)
  ) {
    throw new Error(`Rolldown output escaped target directory: ${filename}`)
  }
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
}

function normalizePlugins(
  value: import('rolldown').RolldownPluginOption,
): import('rolldown').RolldownPluginOption[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}
