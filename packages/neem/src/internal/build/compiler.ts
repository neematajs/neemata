import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, dirname, resolve } from 'node:path'

import type { MaybePromise } from '@nmtjs/common'
import type { OutputOptions, PreRenderedAsset } from 'rolldown'
import { createFuture } from '@nmtjs/common'
import injectableLabelsPlugin from '@nmtjs/unplugin-labels/rolldown'
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

const DEFAULT_DEBOUNCE_MS = 50

const DEFAULT_DEPS_CHUNK_TEST = /node_modules/

const DEFAULT_DEPS_CHUNK_GROUP = {
  name: 'deps',
  test: DEFAULT_DEPS_CHUNK_TEST,
} satisfies NeemChunkGroup

type EntryInput = { key: string; name: string; file: string }

/** Entry chunk file name per build target key, filled in by the build. */
type EntryFileNames = Map<string, string>

export type CompiledTarget = {
  target: BuildTarget
  artifact: NeemResolvedArtifact
}

export type CompiledRuntime = {
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

export type TargetChange = { targets: readonly CompiledTarget[] }

export type GroupWatcher = {
  ready: Promise<readonly CompiledTarget[]>
  close: () => Promise<void>
}

export type GraphWatcher = {
  ready: Promise<CompiledGraph>
  snapshot: () => CompiledGraph
  close: () => Promise<void>
}

export async function compileGraph(graph: BuildGraph): Promise<CompiledGraph> {
  const groups = await Promise.all(graph.buildGroups.map(compileTargets))
  return createCompiledGraph(graph, groups.flat())
}

export async function compileTargets(
  group: BuildGroup,
): Promise<readonly CompiledTarget[]> {
  const entryFileNames: EntryFileNames = new Map()
  await mkdirTargetDirs(group.targets)
  await rolldown.build(createRolldownOptions(group, false, entryFileNames))
  return resolveTargets(group.targets, entryFileNames)
}

export async function watchGraph(
  graph: BuildGraph,
  handlers: { onChange?: (change: TargetChange) => MaybePromise<void> } = {},
): Promise<GraphWatcher> {
  const compiled = new Map<string, CompiledTarget>()
  const watchConfig = graph.config.build?.watch
  const watchers = await Promise.all(
    graph.buildGroups.map((group) =>
      watchTargets(group, {
        watchConfig,
        onRebuild: async (change) => {
          for (const target of change.targets) {
            compiled.set(target.target.key, target)
          }
          await handlers.onChange?.(change)
        },
      }),
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
      return createCompiledGraph(graph, Array.from(compiled.values()))
    },
    async close() {
      await Promise.all(watchers.map((watcher) => watcher.close()))
    },
  }
}

export async function watchTargets(
  group: BuildGroup,
  options: {
    onRebuild?: (change: TargetChange) => MaybePromise<void>
    watchConfig?: NeemBuildWatchConfig
  } = {},
): Promise<GroupWatcher> {
  const { targets } = group
  const entryFileNames: EntryFileNames = new Map()
  await mkdirTargetDirs(targets)
  const watcher = rolldown.watch({
    ...createRolldownOptions(group, true, entryFileNames),
    watch: createWatchOptions(options.watchConfig),
  })

  let initial = true
  let initialTargets: readonly CompiledTarget[] | undefined
  const ready = createFuture<readonly CompiledTarget[]>()

  watcher.on('event', async (event) => {
    switch (event.code) {
      case 'BUNDLE_END':
        try {
          const compiled = resolveTargets(targets, entryFileNames)
          if (initial) initialTargets = compiled
          else await options.onRebuild?.({ targets: compiled })
        } catch (error) {
          // a throw here would otherwise leave the first build pending forever
          if (!initial) throw error
          ready.reject(error)
        } finally {
          if ('result' in event) await event.result?.close?.()
          // Rolldown rebuilds retain sizeable allocations between watch builds;
          // nudge V8 to release them during long dev sessions (no-op unless the
          // process runs with --expose-gc, which bin/neem.js enables).
          globalThis.gc?.()
        }
        return
      case 'END':
        if (!initial) return
        initial = false
        ready.resolve(initialTargets ?? resolveTargets(targets, entryFileNames))
        return
      case 'ERROR':
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

function createCompiledGraph(
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

    return { node: runtime, worker, host, planner }
  })
  const plugins = graph.plugins.map((plugin) => ({
    node: plugin,
    entry: plugin.entry ? byKey.get(plugin.entry.key) : undefined,
  }))

  return { graph, runtimes, plugins, targets }
}

function createWatchOptions(
  config: NeemBuildWatchConfig | undefined,
): NonNullable<rolldown.BuildOptions['watch']> {
  return {
    // Rolldown distinguishes an absent buildDelay from `undefined`.
    ...(config?.buildDelay === undefined
      ? {}
      : { buildDelay: config.buildDelay }),
    clearScreen: false,
    watcher: {
      debounceDelay: config?.debounceDelay ?? DEFAULT_DEBOUNCE_MS,
      useDebounce: true,
    },
  }
}

function createRolldownOptions(
  group: BuildGroup,
  watch: boolean,
  entryFileNames: EntryFileNames,
): rolldown.BuildOptions {
  const [first] = group.targets
  if (!first) throw new Error('Cannot compile an empty build group')
  // Infra entry names are part of the output layout contract, and their
  // modules resolve under node_modules when Neem itself is installed as a
  // dependency — where the default deps group would swallow them.
  const infra = group.kind === 'infra'
  const userOptions = mergeRolldownOptions(first.artifact.rolldown)
  // Neem owns the output topology, so a user-supplied output array (rolldown's
  // multi-output form) has nothing to contribute here.
  const userOutput =
    userOptions.output && !Array.isArray(userOptions.output)
      ? userOptions.output
      : {}
  const inputs: EntryInput[] = group.targets.map((target) => ({
    key: target.key,
    name: target.entryName,
    file: toFilePath(target.artifact.entry),
  }))
  const output: OutputOptions = {
    sourcemap: true,
    minify: false,
    dir: first.outDir,
    format: 'esm',
    ...userOutput,
    entryFileNames: watch || infra ? '[name].js' : '[name]-[hash].js',
    chunkFileNames: watch ? '[name].js' : '[name]-[hash].js',
    assetFileNames: watch
      ? createStableWatchAssetFileName
      : '[name]-[hash][extname]',
    codeSplitting: resolveCodeSplitting(
      first.artifact.chunks,
      infra ? inputs.map((input) => input.file) : [],
    ),
  }

  return {
    input: Object.fromEntries(inputs.map((input) => [input.name, input.file])),
    platform: 'node',
    ...userOptions,
    experimental: {
      // Chunk optimization may regroup chunks between rebuilds; artifact file
      // names must stay stable for running dev workers.
      chunkOptimization: false,
      incrementalBuild: watch,
      ...userOptions.experimental,
    },
    external: createExternalMatcher(userOptions.external),
    plugins: [
      createNativeAddonPlugin(),
      // before user plugins: injectables get labeled with their variable
      // names and declaration sites, so diagnostics stay readable in bundles
      injectableLabelsPlugin(),
      ...normalizePlugins(userOptions.plugins),
      createEntryMetadataPlugin(inputs, entryFileNames),
    ],
    output,
  }
}

function resolveCodeSplitting(
  chunks: NeemChunkingOptions | undefined,
  excludeFromDefaultDeps: readonly string[],
): OutputOptions['codeSplitting'] {
  if (chunks === false) return undefined

  const groups = chunks?.groups ?? []
  if (groups.some((group) => group.name === DEFAULT_DEPS_CHUNK_GROUP.name)) {
    return { groups: [...groups] }
  }

  return {
    groups: [...groups, createDefaultDepsChunkGroup(excludeFromDefaultDeps)],
  }
}

// When Neem itself is installed as a dependency, the grouped infra entry
// modules resolve under node_modules and would match the default deps test —
// merging eagerly-guarded worker/runner entry code into the shared chunk that
// start.js imports on the main thread. Exclude the entry ids explicitly.
function createDefaultDepsChunkGroup(
  excludedIds: readonly string[],
): NeemChunkGroup {
  if (excludedIds.length === 0) return DEFAULT_DEPS_CHUNK_GROUP
  const excluded = new Set(excludedIds)
  return {
    name: DEFAULT_DEPS_CHUNK_GROUP.name,
    test: (id) => !excluded.has(id) && DEFAULT_DEPS_CHUNK_TEST.test(id),
  }
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

function resolveTargets(
  targets: readonly BuildTarget[],
  entryFileNames: EntryFileNames,
): readonly CompiledTarget[] {
  return targets.map((target) => ({
    target,
    artifact: resolveArtifact(target, entryFileNames),
  }))
}

function resolveArtifact(
  target: BuildTarget,
  entryFileNames: EntryFileNames,
): NeemResolvedArtifact {
  const fileName = entryFileNames.get(target.key)
  if (!fileName) {
    throw new Error(`Neem build emitted no entry chunk for [${target.key}]`)
  }

  const { id, kind } = target.artifact
  return {
    id,
    kind,
    owner: target.owner,
    file: resolve(target.outDir, fileName),
    outDir: target.outDir,
  }
}

async function mkdirTargetDirs(targets: readonly BuildTarget[]): Promise<void> {
  const dirs = new Set(targets.map((target) => target.outDir))
  await Promise.all(Array.from(dirs, (dir) => mkdir(dir, { recursive: true })))
}

function createEntryMetadataPlugin(
  inputs: readonly EntryInput[],
  entryFileNames: EntryFileNames,
): rolldown.RolldownPlugin {
  const collect = (bundle: rolldown.OutputBundle) => {
    for (const input of inputs) {
      // an extensionless entry resolves to a facade that differs from the
      // configured path, so the input name is the fallback identity
      const chunk = Object.values(bundle).find(
        (candidate) =>
          candidate.type === 'chunk' &&
          candidate.isEntry &&
          candidate.fileName &&
          (candidate.facadeModuleId === input.file ||
            candidate.name === input.name),
      )
      if (chunk) entryFileNames.set(input.key, chunk.fileName)
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
  }
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
