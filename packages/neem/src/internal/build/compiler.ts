import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path'

import type { MaybePromise } from '@nmtjs/common'
import type { OutputOptions, PreRenderedAsset, RolldownOutput } from 'rolldown'
import type { BindingClientHmrUpdate } from 'rolldown/experimental'
import { createFuture } from '@nmtjs/common'
import * as rolldown from 'rolldown'
import { dev } from 'rolldown/experimental'

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
import { normalizeError, toFilePath } from '../utils.ts'
import { NEEM_DEV_RUNTIME } from './dev-runtime.ts'

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

type PatchController = {
  addClient: (clientId: string) => Promise<void>
  removeClient: (clientId: string) => Promise<void>
  delivered: (filenames: readonly string[]) => Promise<void>
  ensureOutput: () => Promise<void>
}

type WatchHandlers = {
  onRebuild?: (change: TargetChange) => MaybePromise<void>
  onError?: (error: Error) => MaybePromise<void>
}

export type GraphWatcher = {
  addPatchClient: (runtimeName: string, clientId: string) => Promise<void>
  removePatchClient: (runtimeName: string, clientId: string) => Promise<void>
  notifyPatchDelivered: (
    runtimeName: string,
    filenames: readonly string[],
  ) => Promise<void>
  ensureWorkerOutput: (runtimeName: string) => Promise<void>
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
  const artifact = createResolvedArtifact(target, bundle, metadata)
  return { target, artifact }
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
  return createResolvedTargets(targets, bundle, metadata)
}

export async function watchGraph(
  graph: BuildGraph,
  handlers: {
    onChange?: (change: TargetChange) => MaybePromise<void>
    onError?: (error: Error) => MaybePromise<void>
    onUpdates?: (
      runtimeName: string,
      updates: BindingClientHmrUpdate[],
    ) => MaybePromise<void>
    onUpdateError?: (runtimeName: string, error: Error) => MaybePromise<void>
  } = {},
): Promise<GraphWatcher> {
  const compiled = new Map<string, CompiledTarget>()
  const watchConfig = graph.config.build?.watch
  const controllers = new Map<string, PatchController>()
  const watchers = await Promise.all(
    graph.buildGroups.map(async (group): Promise<BuildGroupWatcher> => {
      async function onRebuild(change: TargetChange) {
        for (const target of change.compiledTargets ?? [change.compiled]) {
          compiled.set(target.target.key, target)
        }
        await handlers.onChange?.(change)
      }
      if (group.kind !== 'target' || group.target.kind !== 'runtime-worker') {
        return watchBuildGroup(
          group,
          { onRebuild, onError: handlers.onError },
          watchConfig,
        )
      }
      const target = group.target
      const runtimeName =
        target.owner.type === 'runtime' ? target.owner.name : target.key
      const watcher = await watchWorkerTarget(
        target,
        {
          onRebuild,
          onError: handlers.onError,
          onUpdates: (updates) => handlers.onUpdates?.(runtimeName, updates),
          onUpdateError: (error) =>
            handlers.onUpdateError?.(runtimeName, error),
        },
        watchConfig,
      )
      controllers.set(runtimeName, watcher.patches)
      return {
        ready: watcher.ready.then((target) => [target]),
        close: watcher.close,
      }
    }),
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
    async addPatchClient(runtimeName, clientId) {
      await controllers.get(runtimeName)?.addClient(clientId)
    },
    async removePatchClient(runtimeName, clientId) {
      await controllers.get(runtimeName)?.removeClient(clientId)
    },
    async notifyPatchDelivered(runtimeName, filenames) {
      await controllers.get(runtimeName)?.delivered(filenames)
    },
    async ensureWorkerOutput(runtimeName) {
      await controllers.get(runtimeName)?.ensureOutput()
    },
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
  handlers: WatchHandlers = {},
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
  handlers: WatchHandlers = {},
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
      await handlers.onError?.(event.error)
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
  handlers: WatchHandlers = {},
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
        // Rolldown rebuilds retain sizeable allocations between watch builds;
        // nudge V8 to release them during long dev sessions (no-op unless the
        // process runs with --expose-gc, which bin/neem.js enables).
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
      await handlers.onError?.(event.error)
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

async function watchWorkerTarget(
  target: BuildTarget,
  handlers: WatchHandlers & {
    onUpdates: (updates: BindingClientHmrUpdate[]) => MaybePromise<void>
    onUpdateError: (error: Error) => MaybePromise<void>
  },
  watchConfig?: NeemBuildWatchConfig,
): Promise<TargetWatcher & { patches: PatchController }> {
  const metadata: ArtifactBuildMetadata = { watch: true }
  const ready = createFuture<CompiledTarget>()
  void ready.promise.catch(() => {})
  let initial = true
  let chunks: string[] = []
  let outputApplied = Promise.resolve()
  let assetsWritten = Promise.resolve()
  let updatesApplied = Promise.resolve()

  await mkdir(target.outDir, { recursive: true })
  const { output, ...input } = createRolldownOptions(target, metadata)
  input.experimental = {
    ...input.experimental,
    devMode: { implement: NEEM_DEV_RUNTIME, lazy: false },
  }
  input.plugins = [
    ...normalizePlugins(input.plugins),
    {
      name: 'neem:runtime-restart-boundary',
      transform: {
        filter: { id: toFilePath(target.artifact.entry) },
        handler(code) {
          // The worker definition owns replacement; edits to its dependencies
          // bubble to this boundary before Neem starts a new generation.
          return `${code}\nif (import.meta.hot) import.meta.hot.accept(m => globalThis.__neem_accept_worker__?.(m.default))\n`
        },
      },
    },
  ]

  const engine = await dev(input, output, {
    rebuildStrategy: 'never',
    watch: {
      skipWrite: false,
      useDebounce: true,
      debounceDuration: watchConfig?.debounceDelay ?? 50,
    },
    onOutput(result) {
      // DevEngine does not await callbacks. Keep the application promise so a
      // fresh-output request also waits for the compiled snapshot to catch up.
      outputApplied = applyOutput(result)
      void outputApplied.catch((error) =>
        handlers.onError?.(normalizeError(error)),
      )
    },
    onAdditionalAssets(result) {
      assetsWritten = assetsWritten.then(() =>
        writeOutput(target.outDir, result),
      )
      void assetsWritten.catch((error) =>
        handlers.onError?.(normalizeError(error)),
      )
    },
    onHmrUpdates(result) {
      updatesApplied = updatesApplied
        .then(async () => {
          if (result instanceof Error) {
            await handlers.onUpdateError(result)
            return
          }
          await assetsWritten
          for (const { update } of result.updates) {
            if (update.type !== 'Patch') continue
            await writeOutputFile(target.outDir, update.filename, update.code)
            if (update.sourcemap && update.sourcemapFilename) {
              await writeOutputFile(
                target.outDir,
                update.sourcemapFilename,
                update.sourcemap,
              )
            }
          }
          await handlers.onUpdates(result.updates)
        })
        .catch((error) => handlers.onUpdateError(normalizeError(error)))
    },
  })

  try {
    await engine.run()
    await ready.promise
  } catch (error) {
    await engine.close()
    throw error
  }

  return {
    target,
    ready: ready.promise,
    patches: {
      async addClient(clientId) {
        await engine.registerClient(clientId)
        // A full bundle has already delivered every chunk to the new thread.
        for (const filename of chunks)
          await engine.notifyPayloadDelivered(filename)
      },
      removeClient: (clientId) => engine.removeClient(clientId),
      async delivered(filenames) {
        for (const filename of filenames)
          await engine.notifyPayloadDelivered(filename)
      },
      async ensureOutput() {
        await engine.ensureLatestBuildOutput()
        await outputApplied
      },
    },
    async close() {
      await engine.close()
      await Promise.allSettled([outputApplied, assetsWritten, updatesApplied])
    },
  }

  async function applyOutput(result: Error | RolldownOutput): Promise<void> {
    if (result instanceof Error) {
      if (initial) ready.reject(result)
      throw result
    }
    chunks = result.output
      .filter((item) => item.type === 'chunk')
      .map((item) => item.fileName)
    const artifact = createResolvedArtifact(target, result, metadata)
    const compiled = { target, artifact }
    if (initial) {
      initial = false
      ready.resolve(compiled)
      return
    }
    await handlers.onRebuild?.({ target, compiled, initial: false })
  }
}

async function writeOutput(
  outDir: string,
  output: RolldownOutput,
): Promise<void> {
  await Promise.all(
    output.output.map((item) => {
      const content = item.type === 'asset' ? item.source : item.code
      return writeOutputFile(outDir, item.fileName, content)
    }),
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
      ? userOptions.output
      : {}
  const input = createArtifactInput(target)
  const output: OutputOptions = Object.assign(
    {
      sourcemap: true,
      minify: false,
      dir: target.outDir,
      format: 'esm' as const,
      entryFileNames: metadata.watch ? '[name].js' : '[name]-[hash].js',
      chunkFileNames: metadata.watch ? '[name].js' : '[name]-[hash].js',
      assetFileNames: metadata.watch
        ? createStableWatchAssetFileName
        : '[name]-[hash][extname]',
    },
    userOutput,
    { codeSplitting: resolveCodeSplitting(target.artifact.chunks) },
  )

  return {
    input: input.input,
    platform: 'node',
    ...userOptions,
    experimental: {
      // Chunk optimization may regroup chunks between rebuilds; artifact file
      // names must stay stable for running dev workers.
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
    output,
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
      ? userOptions.output
      : {}
  const inputs = createArtifactInputs(targets)
  const output: OutputOptions = Object.assign(
    {
      sourcemap: true,
      minify: false,
      dir: firstTarget.outDir,
      format: 'esm' as const,
    },
    userOutput,
    {
      entryFileNames: '[name].js',
      chunkFileNames: metadata.watch ? '[name].js' : '[name]-[hash].js',
      assetFileNames: metadata.watch
        ? createStableWatchAssetFileName
        : '[name]-[hash][extname]',
      codeSplitting: resolveCodeSplitting(
        firstTarget.artifact.chunks,
        inputs.map((input) => input.entry),
      ),
    },
  )

  return {
    input: Object.fromEntries(
      inputs.map((input) => [input.input, input.entry]),
    ),
    platform: 'node',
    ...userOptions,
    experimental: { chunkOptimization: false, ...userOptions.experimental },
    external: createExternalMatcher(userOptions.external),
    plugins: [
      createNativeAddonPlugin(),
      ...normalizePlugins(userOptions.plugins),
      createArtifactMetadataPlugin(inputs, metadata),
    ],
    output,
  }
}

const DEFAULT_DEPS_CHUNK_TEST = /node_modules/

const DEFAULT_DEPS_CHUNK_GROUP = {
  name: 'deps',
  test: DEFAULT_DEPS_CHUNK_TEST,
} satisfies NeemChunkGroup

function resolveCodeSplitting(
  chunks: NeemChunkingOptions | undefined,
  excludeFromDefaultDeps: readonly string[] = [],
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

function createArtifactInput(target: BuildTarget): ArtifactInput {
  const entry = toFilePath(target.artifact.entry)
  return { entry, input: entry }
}

function createArtifactInputs(
  targets: readonly BuildTarget[],
): ArtifactInput[] {
  return targets.map((target) => {
    const entry = toFilePath(target.artifact.entry)
    const input = getArtifactInputName(target)
    return { entry, input, targetKey: target.key }
  })
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
  const file = resolve(
    target.outDir,
    groupedEntryFileName ?? entryFileName ?? 'index.js',
  )

  return {
    id: target.artifact.id,
    kind: target.artifact.kind,
    owner: target.owner,
    file,
    outDir: target.outDir,
  }
}

function createResolvedTargets(
  targets: readonly BuildTarget[],
  bundle: RolldownOutput | undefined,
  metadata: ArtifactBuildMetadata,
): readonly CompiledTarget[] {
  return targets.map((target) => {
    const artifact = createResolvedArtifact(target, bundle, metadata)
    return { target, artifact }
  })
}

async function mkdirTargetDirs(targets: readonly BuildTarget[]): Promise<void> {
  const dirs = new Set<string>()
  for (const { outDir } of targets) dirs.add(outDir)

  await Promise.all(Array.from(dirs, (dir) => mkdir(dir, { recursive: true })))
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
