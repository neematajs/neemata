import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

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
import {
  assertRuntimeNamesExist,
  normalizeRuntimeNames,
} from '../runtime-selection.ts'
import { sanitizePathPart } from '../utils.ts'
import { resolveBuildEntry, resolveRequiredBuildEntry } from './resolver.ts'

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
  artifact: {
    id: string
    kind: NeemArtifactKind
    entry: NeemArtifactEntry
    rolldown?: RolldownOptions
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
  rolldown?: RolldownOptions
  options?: unknown
}

export type BuildGroup =
  | {
      key: 'runtime:infra'
      kind: 'infra'
      targets: readonly [BuildTarget, BuildTarget, BuildTarget]
    }
  | {
      key: string
      kind: 'target'
      target: BuildTarget
      targets: readonly [BuildTarget]
    }

export type BuildGraph = {
  configFile: string
  outDir: string
  config: NeemResolvedConfig
  startEntry: BuildTarget
  workerEntry: BuildTarget
  hostRunnerEntry: BuildTarget
  logger?: BuildTarget
  runtimes: readonly RuntimeBuildNode[]
  plugins: readonly PluginBuildNode[]
  targets: readonly BuildTarget[]
  buildGroups: readonly BuildGroup[]
}

export function createBuildGraph(options: {
  configFile: string
  outDir: string
  config: NeemResolvedConfig
  runtimes?: readonly string[]
}): BuildGraph {
  const config = options.config
  const selectedRuntimeNames = normalizeRuntimeNames(options.runtimes)
  const availableRuntimeNames = Object.keys(config.runtimes)
  assertRuntimeNamesExist(selectedRuntimeNames, availableRuntimeNames)
  const selected = selectedRuntimeNames
    ? new Set(selectedRuntimeNames)
    : undefined
  const rootRolldown = createRootBuildRolldownOptions(config.build)
  const plugins = createPluginNodes(
    options.configFile,
    options.outDir,
    config,
    rootRolldown,
  )
  const pluginRolldown = mergePluginRolldownOptions(plugins)
  const startEntry = createStartEntryTarget(options.outDir, rootRolldown)
  const workerEntry = createWorkerEntryTarget(options.outDir, rootRolldown)
  const hostRunnerEntry = createHostRunnerEntryTarget(
    options.outDir,
    rootRolldown,
  )
  const logger = createLoggerTarget(
    options.configFile,
    options.outDir,
    config,
    rootRolldown,
  )
  const runtimes = Object.entries(config.runtimes)
    .filter(([name]) => !selected || selected.has(name))
    .map(([name, runtime]) =>
      createRuntimeNode({
        outDir: options.outDir,
        name,
        runtime,
        pluginRolldown,
        rootRolldown,
      }),
    )
  const targets = [
    startEntry,
    workerEntry,
    hostRunnerEntry,
    ...(logger ? [logger] : []),
    ...runtimes.flatMap((runtime) =>
      [runtime.worker, runtime.host, runtime.planner].filter(
        (target): target is BuildTarget => Boolean(target),
      ),
    ),
    ...plugins.flatMap((plugin) => (plugin.entry ? [plugin.entry] : [])),
  ]
  const infraTargets = [startEntry, workerEntry, hostRunnerEntry] as const
  const buildGroups: BuildGroup[] = [
    { key: 'runtime:infra', kind: 'infra', targets: infraTargets },
    ...targets
      .slice(infraTargets.length)
      .map(
        (target) =>
          ({
            key: target.key,
            kind: 'target',
            target,
            targets: [target],
          }) satisfies BuildGroup,
      ),
  ]

  return {
    configFile: options.configFile,
    outDir: options.outDir,
    config,
    startEntry,
    workerEntry,
    hostRunnerEntry,
    logger,
    runtimes,
    plugins,
    targets,
    buildGroups,
  }
}

function createPluginNodes(
  configFile: string,
  outDir: string,
  config: NeemResolvedConfig,
  rootRolldown?: RolldownOptions,
): readonly PluginBuildNode[] {
  return (config.plugins ?? []).map((plugin, index) => {
    const name = plugin.name.trim()
    if (!name)
      throw new Error(`Neem plugin at index [${index}] must have a name`)

    const key = `${String(index).padStart(3, '0')}-${sanitizePathPart(name)}`
    const entry = resolveBuildEntry(configFile, plugin.entry)

    return {
      key,
      name,
      entry: entry
        ? {
            key: `plugin:${key}`,
            kind: 'plugin-entry',
            artifact: {
              id: 'plugin',
              kind: 'module',
              entry,
              rolldown: rootRolldown,
            },
            owner: { type: 'config' },
            outDir: resolve(outDir, 'config', 'plugins', key),
          }
        : undefined,
      rolldown: normalizeUserRolldownOptions(plugin.build?.rolldown),
      options: plugin.options,
    } satisfies PluginBuildNode
  })
}

function createWorkerEntryTarget(
  outDir: string,
  rootRolldown?: RolldownOptions,
): BuildTarget {
  return {
    key: 'runtime:worker-entry',
    kind: 'worker-entry',
    artifact: {
      id: 'worker-entry',
      kind: 'worker',
      entry: resolveInternalEntry('../worker/entry'),
      rolldown: mergeOptionalRolldownOptions(
        { output: { entryFileNames: 'worker-entry.js' } },
        rootRolldown,
      ),
    },
    owner: { type: 'runtime', name: 'worker' },
    outDir: resolve(outDir, 'runtime'),
  }
}

function createHostRunnerEntryTarget(
  outDir: string,
  rootRolldown?: RolldownOptions,
): BuildTarget {
  return {
    key: 'runtime:host-runner-entry',
    kind: 'host-runner-entry',
    artifact: {
      id: 'host-runner-entry',
      kind: 'worker',
      entry: resolveInternalEntry('../host/runner-entry'),
      rolldown: mergeOptionalRolldownOptions(
        { output: { entryFileNames: 'runner-entry.js' } },
        rootRolldown,
      ),
    },
    owner: { type: 'runtime', name: 'host-runner' },
    outDir: resolve(outDir, 'runtime'),
  }
}

function createStartEntryTarget(
  outDir: string,
  rootRolldown?: RolldownOptions,
): BuildTarget {
  return {
    key: 'runtime:start-entry',
    kind: 'start-entry',
    artifact: {
      id: 'start',
      kind: 'module',
      entry: resolveInternalEntry('../standalone/entry'),
      rolldown: mergeOptionalRolldownOptions(
        {
          output: {
            entryFileNames: 'start.js',
            chunkFileNames: '[name]-[hash].js',
          },
        },
        rootRolldown,
      ),
    },
    owner: { type: 'runtime', name: 'start' },
    outDir: resolve(outDir, 'runtime'),
  }
}

function createLoggerTarget(
  configFile: string,
  outDir: string,
  config: NeemResolvedConfig,
  rootRolldown?: RolldownOptions,
): BuildTarget | undefined {
  const logger = config.logger
  if (!logger || (typeof logger !== 'string' && !(logger instanceof URL))) {
    return undefined
  }

  return {
    key: 'config:logger',
    kind: 'logger',
    artifact: {
      id: 'logger',
      kind: 'module',
      entry: resolveRequiredBuildEntry(configFile, logger),
      rolldown: rootRolldown,
    },
    owner: { type: 'config' },
    outDir: resolve(outDir, 'config', 'logger'),
  }
}

function resolveInternalEntry(name: string): URL {
  const source = new URL(`./${name}.ts`, import.meta.url)
  if (existsSync(source)) return source

  return new URL(`./${name}.js`, import.meta.url)
}

function mergePluginRolldownOptions(
  plugins: readonly PluginBuildNode[],
): RolldownOptions | undefined {
  return plugins.reduce<RolldownOptions | undefined>(
    (merged, plugin) => mergeRolldownOptions(plugin.rolldown, merged),
    undefined,
  )
}

function createRuntimeNode(options: {
  outDir: string
  name: string
  runtime: NeemResolvedRuntimeDeclaration
  pluginRolldown?: RolldownOptions
  rootRolldown?: RolldownOptions
}): RuntimeBuildNode {
  const runtimeDir = resolve(
    options.outDir,
    'runtime',
    sanitizePathPart(options.name),
  )
  const declaration = options.runtime.declaration
  const workerEntry = declaration.worker
    ? resolveRequiredBuildEntry(options.runtime.file, declaration.worker.entry)
    : undefined
  const hostEntry =
    resolveBuildEntry(options.runtime.file, declaration.host?.entry) ??
    resolveInternalEntry('../host/default-host')
  const plannerEntry = resolveRequiredBuildEntry(
    options.runtime.file,
    options.runtime.planner,
  )
  if (!workerEntry && !hostEntry) {
    throw new Error(
      `Runtime [${options.name}] must configure a worker or host entry`,
    )
  }

  return {
    name: options.name,
    declaration: options.runtime,
    worker: workerEntry
      ? {
          key: `runtime:${options.name}:worker`,
          kind: 'runtime-worker',
          artifact: {
            id: 'worker',
            kind: 'worker',
            entry: workerEntry,
            rolldown: mergeOptionalRolldownOptions(
              normalizeUserRolldownOptions(declaration.worker?.build?.rolldown),
              options.pluginRolldown,
              options.rootRolldown,
            ),
            chunks: declaration.worker?.build?.chunks,
          },
          owner: { type: 'runtime', name: options.name },
          outDir: resolve(runtimeDir, 'worker'),
        }
      : undefined,
    host: {
      key: `runtime:${options.name}:host`,
      kind: 'runtime-host',
      artifact: {
        id: 'host',
        kind: 'module',
        entry: hostEntry,
        rolldown: mergeOptionalRolldownOptions(
          normalizeUserRolldownOptions(declaration.host?.build?.rolldown),
          options.rootRolldown,
        ),
        chunks: declaration.host?.build?.chunks,
      },
      owner: { type: 'runtime', name: options.name },
      outDir: resolve(runtimeDir, 'host'),
    },
    planner: {
      key: `runtime:${options.name}:planner`,
      kind: 'runtime-planner',
      artifact: {
        id: 'planner',
        kind: 'module',
        entry: plannerEntry,
        rolldown: mergeOptionalRolldownOptions(
          normalizeUserRolldownOptions(declaration.host?.build?.rolldown),
          options.rootRolldown,
        ),
        chunks: declaration.host?.build?.chunks,
      },
      owner: { type: 'runtime', name: options.name },
      outDir: resolve(runtimeDir, 'planner'),
    },
  }
}

function createRootBuildRolldownOptions(
  build: NeemBuildConfig | undefined,
): RolldownOptions | undefined {
  if (!build) return undefined

  const output: OutputOptions = {}
  if (build.sourcemap !== undefined) output.sourcemap = build.sourcemap
  if (build.minify !== undefined) output.minify = build.minify
  if (build.sourcemapSources !== undefined) {
    output.sourcemapExcludeSources = build.sourcemapSources === 'exclude'
  }

  const rolldown: RolldownOptions = {
    ...(Object.keys(output).length > 0 ? { output } : {}),
    ...(build.define ? { transform: { define: build.define } } : {}),
  }

  return Object.keys(rolldown).length > 0 ? rolldown : undefined
}

function normalizeUserRolldownOptions(
  options: RolldownOptions | undefined,
): RolldownOptions | undefined {
  const merged = mergeUserRolldownOptions(options)
  return Object.keys(merged).length > 0 ? merged : undefined
}

function mergeOptionalRolldownOptions(
  ...options: [RolldownOptions | undefined, ...(RolldownOptions | undefined)[]]
): RolldownOptions | undefined {
  const merged = mergeRolldownOptions(...options)
  return Object.keys(merged).length > 0 ? merged : undefined
}
