import { existsSync } from 'node:fs'
import { basename, extname, resolve } from 'node:path'

import type { OutputOptions, RolldownOptions } from 'rolldown'

import type {
  NeemArtifactEntry,
  NeemArtifactKind,
  NeemArtifactOwner,
  NeemBuildConfig,
  NeemChunkingOptions,
  NeemResolvedConfig,
  NeemResolvedRuntimeDeclaration,
} from '../../shared/types.ts'
import {
  mergeRolldownOptions,
  mergeUserRolldownOptions,
} from '../../shared/rolldown.ts'
import { OUT_LAYOUT } from '../layout.ts'
import { isLoggerModuleInput } from '../logger.ts'
import {
  assertRuntimeNamesExist,
  normalizeRuntimeNames,
} from '../runtime-selection.ts'
import { sanitizePathPart, toFilePath } from '../utils.ts'
import { resolveBuildEntry } from './resolver.ts'

export type BuildTargetKind =
  | 'runtime-worker'
  | 'runtime-host'
  | 'runtime-planner'
  | 'start-entry'
  | 'worker-entry'
  | 'host-runner-entry'
  | 'plugin-entry'
  | 'logger'

export type BuildTarget = {
  key: string
  kind: BuildTargetKind
  /** Rolldown input name, and therefore the base name of the entry chunk. */
  entryName: string
  artifact: {
    id: string
    kind: NeemArtifactKind
    entry: NeemArtifactEntry
    rolldown: RolldownOptions
    chunks?: NeemChunkingOptions
  }
  owner: NeemArtifactOwner
  outDir: string
}

export type RuntimeBuildNode = {
  name: string
  declaration: NeemResolvedRuntimeDeclaration
  worker?: BuildTarget
  host: BuildTarget
  planner: BuildTarget
}

export type PluginBuildNode = {
  key: string
  name: string
  entry?: BuildTarget
  rolldown: RolldownOptions
  options?: unknown
}

/**
 * Targets compiled by a single rolldown build. Infra entries share one output
 * directory and are referenced by fixed paths (the generated `start.js` shim,
 * the manifest worker entry), so the compiler keeps their entry names unhashed
 * and out of the shared deps chunk.
 */
export type BuildGroup = {
  kind: 'infra' | 'artifact'
  targets: readonly BuildTarget[]
}

export type BuildGraph = {
  outDir: string
  config: NeemResolvedConfig
  runtimes: readonly RuntimeBuildNode[]
  plugins: readonly PluginBuildNode[]
  targets: readonly BuildTarget[]
  buildGroups: readonly BuildGroup[]
}

type GraphContext = {
  configFile: string
  outDir: string
  config: NeemResolvedConfig
  rootRolldown: RolldownOptions
}

const INFRA_TARGETS = [
  {
    key: 'runtime:start-entry',
    kind: 'start-entry',
    entryName: 'start',
    id: 'start',
    artifactKind: 'module',
    module: '../standalone/entry',
    owner: 'start',
  },
  {
    key: 'runtime:worker-entry',
    kind: 'worker-entry',
    entryName: 'worker-entry',
    id: 'worker-entry',
    artifactKind: 'worker',
    module: '../worker/entry',
    owner: 'worker',
  },
  {
    key: 'runtime:host-runner-entry',
    kind: 'host-runner-entry',
    entryName: 'runner-entry',
    id: 'host-runner-entry',
    artifactKind: 'worker',
    module: '../host/runner-entry',
    owner: 'host-runner',
  },
] as const satisfies readonly {
  key: string
  kind: BuildTargetKind
  entryName: string
  id: string
  artifactKind: NeemArtifactKind
  module: string
  owner: string
}[]

export function createBuildGraph(options: {
  configFile: string
  outDir: string
  config: NeemResolvedConfig
  runtimes?: readonly string[]
}): BuildGraph {
  const { config, configFile, outDir } = options
  const names = normalizeRuntimeNames(options.runtimes)
  assertRuntimeNamesExist(names, Object.keys(config.runtimes))
  const selected = names ? new Set(names) : undefined
  const rootRolldown = createRootBuildRolldownOptions(config.build)
  const ctx: GraphContext = { configFile, outDir, config, rootRolldown }

  const plugins = createPluginNodes(ctx)
  const pluginRolldown = mergePluginRolldownOptions(plugins)
  const infraTargets = INFRA_TARGETS.map((spec) => createInfraTarget(spec, ctx))
  const logger = createLoggerTarget(ctx)
  const runtimes: RuntimeBuildNode[] = []
  for (const [name, runtime] of Object.entries(config.runtimes)) {
    if (selected && !selected.has(name)) continue
    runtimes.push(createRuntimeNode(ctx, name, runtime, pluginRolldown))
  }

  const artifactTargets: BuildTarget[] = []
  if (logger) artifactTargets.push(logger)
  for (const { worker, host, planner } of runtimes) {
    if (worker) artifactTargets.push(worker)
    artifactTargets.push(host, planner)
  }
  for (const { entry } of plugins) {
    if (entry) artifactTargets.push(entry)
  }

  return {
    outDir,
    config,
    runtimes,
    plugins,
    targets: [...infraTargets, ...artifactTargets],
    buildGroups: [
      { kind: 'infra', targets: infraTargets },
      ...artifactTargets.map((target) => ({
        kind: 'artifact' as const,
        targets: [target],
      })),
    ],
  }
}

function createPluginNodes(ctx: GraphContext): readonly PluginBuildNode[] {
  return (ctx.config.plugins ?? []).map((plugin, index) => {
    const name = plugin.name.trim()
    if (!name)
      throw new Error(`Neem plugin at index [${index}] must have a name`)

    const key = `${String(index).padStart(3, '0')}-${sanitizePathPart(name)}`
    const entry = plugin.entry
      ? resolveBuildEntry(ctx.configFile, plugin.entry)
      : undefined

    return {
      key,
      name,
      entry: entry
        ? {
            key: `plugin:${key}`,
            kind: 'plugin-entry',
            entryName: toEntryName(entry),
            artifact: {
              id: 'plugin',
              kind: 'module',
              entry,
              rolldown: ctx.rootRolldown,
            },
            owner: { type: 'config' },
            outDir: resolve(ctx.outDir, OUT_LAYOUT.plugins, key),
          }
        : undefined,
      rolldown: mergeUserRolldownOptions(plugin.build?.rolldown),
      options: plugin.options,
    } satisfies PluginBuildNode
  })
}

function createInfraTarget(
  spec: (typeof INFRA_TARGETS)[number],
  ctx: GraphContext,
): BuildTarget {
  return {
    key: spec.key,
    kind: spec.kind,
    entryName: spec.entryName,
    artifact: {
      id: spec.id,
      kind: spec.artifactKind,
      entry: resolveInternalEntry(spec.module),
      rolldown: ctx.rootRolldown,
    },
    owner: { type: 'runtime', name: spec.owner },
    outDir: resolve(ctx.outDir, OUT_LAYOUT.runtime),
  }
}

function createLoggerTarget(ctx: GraphContext): BuildTarget | undefined {
  const logger = ctx.config.logger
  if (!isLoggerModuleInput(logger)) return undefined

  const entry = resolveBuildEntry(ctx.configFile, logger)
  return {
    key: 'config:logger',
    kind: 'logger',
    entryName: toEntryName(entry),
    artifact: {
      id: 'logger',
      kind: 'module',
      entry,
      rolldown: ctx.rootRolldown,
    },
    owner: { type: 'config' },
    outDir: resolve(ctx.outDir, OUT_LAYOUT.logger),
  }
}

function resolveInternalEntry(name: string): URL {
  const source = new URL(`./${name}.ts`, import.meta.url)
  if (existsSync(source)) return source

  return new URL(`./${name}.js`, import.meta.url)
}

// Rolldown derives the `[name]` placeholder from the input key, so entry
// chunks stay recognisable when they are named after their source file.
function toEntryName(entry: NeemArtifactEntry): string {
  const file = toFilePath(entry)
  return basename(file, extname(file))
}

function mergePluginRolldownOptions(
  plugins: readonly PluginBuildNode[],
): RolldownOptions {
  return plugins.reduce<RolldownOptions>(
    (merged, plugin) => mergeRolldownOptions(plugin.rolldown, merged),
    {},
  )
}

function createRuntimeNode(
  ctx: GraphContext,
  name: string,
  runtime: NeemResolvedRuntimeDeclaration,
  pluginRolldown: RolldownOptions,
): RuntimeBuildNode {
  const runtimeDir = resolve(
    ctx.outDir,
    OUT_LAYOUT.runtime,
    sanitizePathPart(name),
  )
  const { declaration } = runtime
  const hostRolldown = mergeUserRolldownOptions(
    declaration.host?.build?.rolldown,
  )
  const hostChunks = declaration.host?.build?.chunks

  return {
    name,
    declaration: runtime,
    worker: declaration.worker
      ? createRuntimeTarget({
          key: `runtime:${name}:worker`,
          kind: 'runtime-worker',
          id: 'worker',
          artifactKind: 'worker',
          entry: resolveBuildEntry(runtime.file, declaration.worker.entry),
          rolldown: mergeRolldownOptions(
            mergeUserRolldownOptions(declaration.worker.build?.rolldown),
            pluginRolldown,
            ctx.rootRolldown,
          ),
          chunks: declaration.worker.build?.chunks,
          owner: name,
          outDir: resolve(runtimeDir, 'worker'),
        })
      : undefined,
    host: createRuntimeTarget({
      key: `runtime:${name}:host`,
      kind: 'runtime-host',
      id: 'host',
      artifactKind: 'module',
      entry: declaration.host?.entry
        ? resolveBuildEntry(runtime.file, declaration.host.entry)
        : resolveInternalEntry('../host/default-host'),
      rolldown: mergeRolldownOptions(hostRolldown, ctx.rootRolldown),
      chunks: hostChunks,
      owner: name,
      outDir: resolve(runtimeDir, 'host'),
    }),
    planner: createRuntimeTarget({
      key: `runtime:${name}:planner`,
      kind: 'runtime-planner',
      id: 'planner',
      artifactKind: 'module',
      entry: resolveBuildEntry(runtime.file, runtime.planner),
      rolldown: mergeRolldownOptions(hostRolldown, ctx.rootRolldown),
      chunks: hostChunks,
      owner: name,
      outDir: resolve(runtimeDir, 'planner'),
    }),
  }
}

function createRuntimeTarget(options: {
  key: string
  kind: BuildTargetKind
  id: string
  artifactKind: NeemArtifactKind
  entry: NeemArtifactEntry
  rolldown: RolldownOptions
  chunks?: NeemChunkingOptions
  owner: string
  outDir: string
}): BuildTarget {
  const { entry, id, artifactKind, rolldown, chunks } = options
  return {
    key: options.key,
    kind: options.kind,
    entryName: toEntryName(entry),
    artifact: { id, kind: artifactKind, entry, rolldown, chunks },
    owner: { type: 'runtime', name: options.owner },
    outDir: options.outDir,
  }
}

function createRootBuildRolldownOptions(
  build: NeemBuildConfig | undefined,
): RolldownOptions {
  if (!build) return {}

  const output: OutputOptions = {}
  if (build.sourcemap !== undefined) output.sourcemap = build.sourcemap
  if (build.minify !== undefined) output.minify = build.minify
  if (build.sourcemapSources !== undefined) {
    output.sourcemapExcludeSources = build.sourcemapSources === 'exclude'
  }

  return {
    ...(Object.keys(output).length > 0 ? { output } : {}),
    ...(build.define ? { transform: { define: build.define } } : {}),
  }
}
