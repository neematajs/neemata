import { mkdir } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { basename, resolve } from 'node:path'

import type { MaybePromise } from '@nmtjs/common'
import type { RolldownOutput } from 'rolldown'
import { createFuture } from '@nmtjs/common'
import * as rolldown from 'rolldown'

import type { NeemResolvedArtifact } from '../../shared/types.ts'
// import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  BuildGraph,
  BuildTarget,
  PluginBuildNode,
  RuntimeBuildNode,
} from './graph.ts'
import { mergeRolldownOptions } from '../../shared/rolldown.ts'
import { toFilePath } from '../shared/utils.ts'

// import { mergeRolldownOptions } from './rolldown-options.ts'

type ArtifactInput = { entry: string; input: string }

type ArtifactBuildMetadata = { entryFileName?: string }

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
  const targets = await Promise.all(
    graph.targets.map((target) => compileTarget(target)),
  )
  return createCompiledGraph(graph, targets)
}

export async function compileTarget(
  target: BuildTarget,
): Promise<CompiledTarget> {
  const metadata: ArtifactBuildMetadata = {}
  await mkdir(target.outDir, { recursive: true })
  const bundle = await rolldown.build(createRolldownOptions(target, metadata))
  return {
    target,
    artifact: createResolvedArtifact(target, bundle, metadata),
    bundle,
  }
}

export async function watchGraph(
  graph: BuildGraph,
  handlers: { onChange?: (change: TargetChange) => MaybePromise<void> } = {},
): Promise<GraphWatcher> {
  const compiled = new Map<string, CompiledTarget>()
  const watchers = await Promise.all(
    graph.targets.map((target) =>
      watchTarget(target, {
        onRebuild: async (change) => {
          compiled.set(change.target.key, change.compiled)
          await handlers.onChange?.(change)
        },
      }),
    ),
  )
  const ready = Promise.all(watchers.map((watcher) => watcher.ready)).then(
    (targets) => {
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

export async function watchTarget(
  target: BuildTarget,
  handlers: { onRebuild?: (change: TargetChange) => MaybePromise<void> } = {},
): Promise<TargetWatcher> {
  const initial = await compileTarget(target)
  const metadata: ArtifactBuildMetadata = {}
  await mkdir(target.outDir, { recursive: true })
  const watcher = rolldown.watch({
    ...createRolldownOptions(target, metadata),
    watch: {
      buildDelay: 100,
      clearScreen: false,
      watcher: { debounceDelay: 50, useDebounce: true },
    },
  })

  let initialWatchBuild = true
  const ready = createFuture<CompiledTarget>()

  watcher.on('event', async (event) => {
    const code = event?.code
    if (code === 'START' || code === 'BUNDLE_START') return

    if (code === 'BUNDLE_END') {
      if (initialWatchBuild) {
        if ('result' in event) await event.result?.close?.()
        return
      }

      try {
        const compiled = {
          target,
          artifact: createResolvedArtifact(target, undefined, metadata),
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
        ready.resolve(initial)
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
    ...userOptions,
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
      entryFileNames: '[name]-[hash].js',
      chunkFileNames: '[name]-[hash].js',
      assetFileNames: '[name]-[hash][extname]',
      ...userOutput,
    },
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

  return {
    id: target.artifact.id,
    kind: target.artifact.kind,
    owner: target.owner,
    file: resolve(target.outDir, entryFileName ?? 'index.js'),
    outDir: target.outDir,
    bundle,
  }
}

function createArtifactMetadataPlugin(
  input: ArtifactInput,
  metadata: ArtifactBuildMetadata,
): rolldown.RolldownPlugin {
  const collect = (bundle: rolldown.OutputBundle) => {
    const entryChunk = Object.values(bundle).find(
      (chunk) =>
        chunk.type === 'chunk' &&
        chunk.isEntry &&
        chunk.fileName &&
        chunk.facadeModuleId === input.entry,
    )
    metadata.entryFileName = entryChunk?.fileName
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
