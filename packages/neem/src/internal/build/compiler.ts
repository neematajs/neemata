import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

import type { MaybePromise } from '@nmtjs/common'
import type { OutputOptions, PreRenderedAsset, RolldownOutput } from 'rolldown'
import { createFuture } from '@nmtjs/common'
import * as rolldown from 'rolldown'

import type {
  NeemBuildWatchConfig,
  NeemChunkGroup,
  NeemChunkingOptions,
  NeemResolvedArtifact,
} from '../../shared/types.ts'
import type {
  BuildGraph,
  BuildGroup,
  BuildTarget,
  PluginBuildNode,
  RuntimeBuildNode,
} from './graph.ts'
import { mergeRolldownOptions } from '../../shared/rolldown.ts'
import { toFilePath } from '../utils.ts'

type ArtifactInput = { entry: string; input: string; targetKey?: string }

type ArtifactBuildMetadata = {
  entryFileName?: string
  entryFileNames?: Map<string, string | undefined>
  watch: boolean
}

export type CompiledTarget = {
  target: BuildTarget
  artifact: NeemResolvedArtifact
  bundle?: RolldownOutput
}

export type CompiledRuntime = {
  name: string
  node: RuntimeBuildNode
  worker?: CompiledTarget
  host: CompiledTarget
  planner: CompiledTarget
}

export type CompiledPlugin = { node: PluginBuildNode; entry?: CompiledTarget }

export type CompiledGraph = {
  graph: BuildGraph
  runtimes: readonly CompiledRuntime[]
  plugins: readonly CompiledPlugin[]
  targets: readonly CompiledTarget[]
}

export type TargetChange = {
  target: BuildTarget
  compiled: CompiledTarget
  compiledTargets?: readonly CompiledTarget[]
  initial: boolean
}

export type TargetWatcher = {
  target: BuildTarget
  ready: Promise<CompiledTarget>
  close: () => Promise<void>
}

export type GraphWatcher = {
  ready: Promise<CompiledGraph>
  snapshot: () => CompiledGraph
  close: () => Promise<void>
}

export async function compileGraph(graph: BuildGraph): Promise<CompiledGraph> {
  const groups = await Promise.all(
    graph.buildGroups.map((group) => compileBuildGroup(group)),
  )
  return createCompiledGraph(graph, groups.flat())
}

async function compileBuildGroup(
  group: BuildGroup,
): Promise<readonly CompiledTarget[]> {
  if (group.kind === 'target') return [await compileTarget(group.target)]
  return compileTargetGroup(group.targets)
}

export async function compileTarget(
  target: BuildTarget,
): Promise<CompiledTarget> {
  const metadata: ArtifactBuildMetadata = { watch: false }
  await mkdir(target.outDir, { recursive: true })
  const bundle = await rolldown.build(createRolldownOptions(target, metadata))
  return { target, artifact: createResolvedArtifact(target, bundle, metadata) }
}

async function compileTargetGroup(
  targets: readonly BuildTarget[],
): Promise<readonly CompiledTarget[]> {
  const metadata: ArtifactBuildMetadata = {
    entryFileNames: new Map(),
    watch: false,
  }
  await mkdirTargetDirs(targets)
  const bundle = await rolldown.build(
    createGroupedRolldownOptions(targets, metadata),
  )
  return targets.map((target) => ({
    target,
    artifact: createResolvedArtifact(target, bundle, metadata),
  }))
}

export async function watchGraph(
  graph: BuildGraph,
  handlers: { onChange?: (change: TargetChange) => MaybePromise<void> } = {},
): Promise<GraphWatcher> {
  const compiled = new Map<string, CompiledTarget>()
  const watchConfig = graph.config.build?.watch
  const watchers = await Promise.all(
    graph.buildGroups.map((group) =>
      watchBuildGroup(
        group,
        {
          onRebuild: async (change) => {
            for (const target of change.compiledTargets ?? [change.compiled]) {
              compiled.set(target.target.key, target)
            }
            await handlers.onChange?.(change)
          },
        },
        watchConfig,
      ),
    ),
  )
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
  }
}

type BuildGroupWatcher = {
  ready: Promise<readonly CompiledTarget[]>
  close: () => Promise<void>
}

async function watchBuildGroup(
  group: BuildGroup,
  handlers: { onRebuild?: (change: TargetChange) => MaybePromise<void> } = {},
  watchConfig?: NeemBuildWatchConfig,
): Promise<BuildGroupWatcher> {
  if (group.kind === 'target') {
    const watcher = await watchTarget(group.target, handlers, watchConfig)
    return {
      ready: watcher.ready.then((target) => [target]),
      close: watcher.close,
    }
  }

  return watchTargetGroup(group.targets, handlers, watchConfig)
}

export async function watchTarget(
  target: BuildTarget,
  handlers: { onRebuild?: (change: TargetChange) => MaybePromise<void> } = {},
  watchConfig?: NeemBuildWatchConfig,
): Promise<TargetWatcher> {
  const metadata: ArtifactBuildMetadata = { watch: true }
  await mkdir(target.outDir, { recursive: true })
  const watcher = rolldown.watch({
    ...createRolldownOptions(target, metadata),
    watch: createWatchOptions(watchConfig),
  })

  let initialWatchBuild = true
  let initialCompiled: CompiledTarget | undefined
  const ready = createFuture<CompiledTarget>()

  watcher.on('event', async (event) => {
    const code = event?.code
    if (code === 'START' || code === 'BUNDLE_START') return

    if (code === 'BUNDLE_END') {
      try {
        const compiled = {
          target,
          artifact: createResolvedArtifact(target, undefined, metadata),
        }
        if (initialWatchBuild) {
          initialCompiled = compiled
          return
        }

        await handlers.onRebuild?.({ target, compiled, initial: false })
      } finally {
        if ('result' in event) await event.result?.close?.()
      }
      return
    }

    if (code === 'END') {
      if (initialWatchBuild) {
        initialWatchBuild = false
        ready.resolve(
          initialCompiled ?? {
            target,
            artifact: createResolvedArtifact(target, undefined, metadata),
          },
        )
      }
      return
    }

    if (code === 'ERROR') {
      ready.reject(event.error)
      if ('result' in event) await event.result?.close?.()
    }
  })

  return {
    target,
    ready: ready.promise,
    async close() {
      await watcher.close()
    },
  }
}

async function watchTargetGroup(
  targets: readonly BuildTarget[],
  handlers: { onRebuild?: (change: TargetChange) => MaybePromise<void> } = {},
  watchConfig?: NeemBuildWatchConfig,
): Promise<BuildGroupWatcher> {
  const metadata: ArtifactBuildMetadata = {
    entryFileNames: new Map(),
    watch: true,
  }
  await mkdirTargetDirs(targets)
  const watcher = rolldown.watch({
    ...createGroupedRolldownOptions(targets, metadata),
    watch: createWatchOptions(watchConfig),
  })

  let initialWatchBuild = true
  let initialCompiled: readonly CompiledTarget[] | undefined
  const ready = createFuture<readonly CompiledTarget[]>()

  watcher.on('event', async (event) => {
    const code = event?.code
    if (code === 'START' || code === 'BUNDLE_START') return

    if (code === 'BUNDLE_END') {
      try {
        const compiledTargets = createResolvedTargets(
          targets,
          undefined,
          metadata,
        )
        if (initialWatchBuild) {
          initialCompiled = compiledTargets
          return
        }

        await handlers.onRebuild?.({
          target: targets[0]!,
          compiled: compiledTargets[0]!,
          compiledTargets,
          initial: false,
        })
      } finally {
        if ('result' in event) await event.result?.close?.()
        globalThis.gc?.()
      }
      return
    }

    if (code === 'END') {
      if (initialWatchBuild) {
        initialWatchBuild = false
        ready.resolve(
          initialCompiled ??
            createResolvedTargets(targets, undefined, metadata),
        )
      }
      return
    }

    if (code === 'ERROR') {
      ready.reject(event.error)
      if ('result' in event) await event.result?.close?.()
    }
  })

  return {
    ready: ready.promise,
    async close() {
      await watcher.close()
    },
  }
}

function createWatchOptions(
  config: NeemBuildWatchConfig | undefined,
): NonNullable<rolldown.BuildOptions['watch']> {
  return {
    ...(config?.buildDelay !== undefined
      ? { buildDelay: config.buildDelay }
      : {}),
    clearScreen: false,
    watcher: { debounceDelay: config?.debounceDelay ?? 50, useDebounce: true },
  }
}

export function createCompiledGraph(
  graph: BuildGraph,
  targets: readonly CompiledTarget[],
): CompiledGraph {
  const byKey = new Map(targets.map((target) => [target.target.key, target]))
  const runtimes = graph.runtimes.map((runtime) => {
    const worker = runtime.worker ? byKey.get(runtime.worker.key) : undefined
    const host = byKey.get(runtime.host.key)
    const planner = byKey.get(runtime.planner.key)
    if (runtime.worker && !worker) {
      throw new Error(`Compiled runtime [${runtime.name}] worker is missing`)
    }
    if (!host) {
      throw new Error(`Compiled runtime [${runtime.name}] host is missing`)
    }
    if (!planner) {
      throw new Error(`Compiled runtime [${runtime.name}] planner is missing`)
    }

    return { name: runtime.name, node: runtime, worker, host, planner }
  })
  const plugins = graph.plugins.map((plugin) => ({
    node: plugin,
    entry: plugin.entry ? byKey.get(plugin.entry.key) : undefined,
  }))

  return { graph, runtimes, plugins, targets }
}

function createRolldownOptions(
  target: BuildTarget,
  metadata: ArtifactBuildMetadata,
): rolldown.BuildOptions {
  const userOptions = mergeRolldownOptions(target.artifact.rolldown) ?? {}
  const userOutput =
    typeof userOptions.output === 'object' && userOptions.output
      ? (userOptions.output as Record<string, unknown>)
      : {}
  const input = createArtifactInput(target)

  return {
    input: input.input,
    platform: 'node',
    treeshake: false,
    ...userOptions,
    experimental: {
      chunkOptimization: false,
      incrementalBuild: metadata.watch,
      ...userOptions.experimental,
    },
    external: createExternalMatcher(userOptions.external),
    plugins: [
      createNativeAddonPlugin(),
      ...normalizePlugins(userOptions.plugins),
      createArtifactMetadataPlugin(input, metadata),
    ],
    output: {
      sourcemap: true,
      minify: false,
      dir: target.outDir,
      format: 'esm',
      entryFileNames: metadata.watch ? '[name].js' : '[name]-[hash].js',
      chunkFileNames: metadata.watch ? '[name].js' : '[name]-[hash].js',
      assetFileNames: metadata.watch
        ? createStableWatchAssetFileName
        : '[name]-[hash][extname]',
      ...userOutput,
      codeSplitting: resolveCodeSplitting(target.artifact.chunks),
    },
  }
}

function createGroupedRolldownOptions(
  targets: readonly BuildTarget[],
  metadata: ArtifactBuildMetadata,
): rolldown.BuildOptions {
  const firstTarget = targets[0]
  if (!firstTarget) throw new Error('Cannot compile an empty build group')
  const userOptions = mergeRolldownOptions(firstTarget.artifact.rolldown) ?? {}
  const userOutput =
    typeof userOptions.output === 'object' && userOptions.output
      ? (userOptions.output as Record<string, unknown>)
      : {}
  const inputs = createArtifactInputs(targets)

  return {
    input: Object.fromEntries(
      inputs.map((input) => [input.input, input.entry]),
    ),
    platform: 'node',
    treeshake: false,
    ...userOptions,
    experimental: { chunkOptimization: false, ...userOptions.experimental },
    external: createExternalMatcher(userOptions.external),
    plugins: [
      createNativeAddonPlugin(),
      ...normalizePlugins(userOptions.plugins),
      createArtifactMetadataPlugin(inputs, metadata),
    ],
    output: {
      sourcemap: true,
      minify: false,
      dir: firstTarget.outDir,
      format: 'esm',
      ...userOutput,
      entryFileNames: '[name].js',
      chunkFileNames: metadata.watch ? '[name].js' : '[name]-[hash].js',
      assetFileNames: metadata.watch
        ? createStableWatchAssetFileName
        : '[name]-[hash][extname]',
      codeSplitting: resolveCodeSplitting(firstTarget.artifact.chunks),
    },
  }
}

const DEFAULT_DEPS_CHUNK_GROUP = {
  name: 'deps',
  test: /node_modules/,
} satisfies NeemChunkGroup

function resolveCodeSplitting(
  chunks: NeemChunkingOptions | undefined,
): OutputOptions['codeSplitting'] {
  if (chunks === false) return undefined

  const groups = chunks?.groups ?? []
  if (groups.some((group) => group.name === DEFAULT_DEPS_CHUNK_GROUP.name)) {
    return { groups: [...groups] }
  }

  return { groups: [...groups, DEFAULT_DEPS_CHUNK_GROUP] }
}

function createExternalMatcher(
  userExternal: rolldown.BuildOptions['external'],
): rolldown.BuildOptions['external'] {
  return (id, importer, isResolved) => {
    if (isBuiltin(id)) return true
    if (!userExternal) return false
    if (typeof userExternal === 'function') {
      return userExternal(id, importer, isResolved)
    }
    if (Array.isArray(userExternal)) {
      return userExternal.some((external) =>
        typeof external === 'string' ? external === id : external.test(id),
      )
    }
    return userExternal === id
  }
}

function createArtifactInput(target: BuildTarget): ArtifactInput {
  const entry = toFilePath(target.artifact.entry)
  return { entry, input: entry }
}

function createArtifactInputs(
  targets: readonly BuildTarget[],
): ArtifactInput[] {
  return targets.map((target) => ({
    entry: toFilePath(target.artifact.entry),
    input: getArtifactInputName(target),
    targetKey: target.key,
  }))
}

function getArtifactInputName(target: BuildTarget): string {
  switch (target.kind) {
    case 'start-entry':
      return 'start'
    case 'worker-entry':
      return 'worker-entry'
    case 'host-runner-entry':
      return 'runner-entry'
    default:
      return target.artifact.id
  }
}

function createResolvedArtifact(
  target: BuildTarget,
  bundle: RolldownOutput | undefined,
  metadata: ArtifactBuildMetadata,
): NeemResolvedArtifact {
  const entryChunk = bundle?.output.find(
    (chunk) =>
      chunk.type === 'chunk' &&
      chunk.isEntry &&
      chunk.fileName &&
      chunk.facadeModuleId === toFilePath(target.artifact.entry),
  )
  const entryFileName = metadata.entryFileName ?? entryChunk?.fileName
  const groupedEntryFileName = metadata.entryFileNames?.get(target.key)

  return {
    id: target.artifact.id,
    kind: target.artifact.kind,
    owner: target.owner,
    file: resolve(
      target.outDir,
      groupedEntryFileName ?? entryFileName ?? 'index.js',
    ),
    outDir: target.outDir,
  }
}

function createResolvedTargets(
  targets: readonly BuildTarget[],
  bundle: RolldownOutput | undefined,
  metadata: ArtifactBuildMetadata,
): readonly CompiledTarget[] {
  return targets.map((target) => ({
    target,
    artifact: createResolvedArtifact(target, bundle, metadata),
  }))
}

async function mkdirTargetDirs(targets: readonly BuildTarget[]): Promise<void> {
  await Promise.all(
    [...new Set(targets.map((target) => target.outDir))].map((outDir) =>
      mkdir(outDir, { recursive: true }),
    ),
  )
}

function createArtifactMetadataPlugin(
  input: ArtifactInput | readonly ArtifactInput[],
  metadata: ArtifactBuildMetadata,
): rolldown.RolldownPlugin {
  const inputs = Array.isArray(input) ? input : [input]
  const collect = (bundle: rolldown.OutputBundle) => {
    for (const input of inputs) {
      const entryChunk = Object.values(bundle).find(
        (chunk) =>
          chunk.type === 'chunk' &&
          chunk.isEntry &&
          chunk.fileName &&
          chunk.facadeModuleId === input.entry,
      )
      if (metadata.entryFileNames) {
        metadata.entryFileNames.set(
          input.targetKey ?? input.input,
          entryChunk?.fileName,
        )
      } else {
        metadata.entryFileName = entryChunk?.fileName
      }
    }
  }

  return {
    name: 'neem-entry-metadata',
    generateBundle(_options, bundle) {
      collect(bundle)
    },
    writeBundle(_options, bundle) {
      collect(bundle)
    },
  } satisfies rolldown.RolldownPlugin
}

function createNativeAddonPlugin(): rolldown.RolldownPlugin {
  return {
    name: 'neem:native-addon',
    async load(this: rolldown.PluginContext, id: string) {
      if (!id.endsWith('.node')) return null
      const accessible = await this.fs.stat(id).then(
        () => true,
        () => false,
      )
      if (!accessible) return null

      const refId = this.emitFile({
        type: 'asset',
        name: basename(id),
        source: await this.fs.readFile(id),
      })
      const runtimePath = `./${this.getFileName(refId)}`

      return [
        'import { createRequire } from "node:module"',
        'const require = createRequire(import.meta.url)',
        `export default require(${JSON.stringify(runtimePath)})`,
      ].join('\n')
    },
  }
}

function normalizePlugins(
  value: rolldown.RolldownPluginOption,
): rolldown.RolldownPluginOption[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}

function createStableWatchAssetFileName(asset: PreRenderedAsset): string {
  const source = asset.originalFileNames[0] ?? asset.names[0] ?? 'asset'
  const dirHash = createHash('sha1')
    .update(dirname(source))
    .digest('hex')
    .slice(0, 8)
  return `assets/${dirHash}/[name][extname]`
}
