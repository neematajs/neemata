import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  NeemArtifact,
  NeemArtifactEntry,
  NeemArtifactKind,
  NeemArtifactOwner,
  NeemRolldownOptions,
} from '../../public/artifact.ts'
import type {
  NeemConfig,
  NeemNormalizedConfig,
  NeemRuntimeConfigBase,
} from '../../public/config.ts'
import { normalizeNeemConfig } from '../../public/config.ts'
import {
  assertRuntimeNamesExist,
  normalizeRuntimeNames,
} from '../shared/runtime-selection.ts'
import { sanitizePathPart } from '../shared/utils.ts'
import { resolveBuildEntry, resolveRequiredBuildEntry } from './resolver.ts'
import { mergeRolldownOptions } from './rolldown-options.ts'

export type BuildTargetKind =
  | 'runtime-worker'
  | 'runtime-host'
  | 'runtime-artifact'
  | 'start-entry'
  | 'worker-entry'
  | 'plugin-entry'
  | 'logger'

export type BuildTarget = {
  key: string
  kind: BuildTargetKind
  artifact: {
    id: string
    kind: NeemArtifactKind
    entry: NeemArtifactEntry
    rolldown?: NeemRolldownOptions
  }
  owner: NeemArtifactOwner
  outDir: string
}

export type RuntimeBuildNode = {
  name: string
  config: NeemRuntimeConfigBase
  worker?: BuildTarget
  host?: BuildTarget
  artifacts: readonly BuildTarget[]
}

export type PluginBuildNode = {
  key: string
  name: string
  entry?: BuildTarget
  rolldown?: NeemRolldownOptions
  options?: unknown
}

export type BuildGraph = {
  configFile: string
  outDir: string
  config: NeemNormalizedConfig
  startEntry: BuildTarget
  workerEntry: BuildTarget
  logger?: BuildTarget
  runtimes: readonly RuntimeBuildNode[]
  plugins: readonly PluginBuildNode[]
  targets: readonly BuildTarget[]
}

export function createBuildGraph(options: {
  configFile: string
  outDir: string
  config: NeemConfig
  runtimes?: readonly string[]
}): BuildGraph {
  const config = normalizeNeemConfig(options.config) as NeemNormalizedConfig
  const selectedRuntimeNames = normalizeRuntimeNames(options.runtimes)
  const availableRuntimeNames = Object.keys(config.runtimes)
  assertRuntimeNamesExist(selectedRuntimeNames, availableRuntimeNames)
  const selected = selectedRuntimeNames
    ? new Set(selectedRuntimeNames)
    : undefined
  const plugins = createPluginNodes(options.configFile, options.outDir, config)
  const pluginRolldown = mergePluginRolldownOptions(plugins)
  const startEntry = createStartEntryTarget(options.outDir)
  const workerEntry = createWorkerEntryTarget(options.outDir)
  const logger = createLoggerTarget(options.configFile, options.outDir, config)
  const runtimes = Object.entries(config.runtimes)
    .filter(([name]) => !selected || selected.has(name))
    .map(([name, runtime]) =>
      createRuntimeNode({
        configFile: options.configFile,
        outDir: options.outDir,
        name,
        runtime,
        pluginRolldown,
      }),
    )
  const targets = [
    startEntry,
    workerEntry,
    ...(logger ? [logger] : []),
    ...runtimes.flatMap((runtime) =>
      [runtime.worker, runtime.host, ...runtime.artifacts].filter(
        (target): target is BuildTarget => Boolean(target),
      ),
    ),
    ...plugins.flatMap((plugin) => (plugin.entry ? [plugin.entry] : [])),
  ]

  return {
    configFile: options.configFile,
    outDir: options.outDir,
    config,
    startEntry,
    workerEntry,
    logger,
    runtimes,
    plugins,
    targets,
  }
}

function createPluginNodes(
  configFile: string,
  outDir: string,
  config: NeemNormalizedConfig,
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
            artifact: { id: 'plugin', kind: 'module', entry },
            owner: { type: 'config' },
            outDir: resolve(outDir, 'config', 'plugins', key),
          }
        : undefined,
      rolldown: plugin.build?.rolldown,
      options: plugin.options,
    } satisfies PluginBuildNode
  })
}

function createWorkerEntryTarget(outDir: string): BuildTarget {
  return {
    key: 'runtime:worker-entry',
    kind: 'worker-entry',
    artifact: {
      id: 'worker-entry',
      kind: 'worker',
      entry: resolveInternalEntry('../worker/entry'),
      rolldown: { output: { entryFileNames: 'worker-entry.js' } },
    },
    owner: { type: 'runtime', name: 'worker' },
    outDir: resolve(outDir, 'runtime'),
  }
}

function createStartEntryTarget(outDir: string): BuildTarget {
  return {
    key: 'runtime:start-entry',
    kind: 'start-entry',
    artifact: {
      id: 'start',
      kind: 'module',
      entry: resolveInternalEntry('../standalone/entry'),
      rolldown: {
        output: {
          entryFileNames: 'start.js',
          chunkFileNames: '[name]-[hash].js',
        },
      },
    },
    owner: { type: 'runtime', name: 'start' },
    outDir: resolve(outDir, 'runtime'),
  }
}

function createLoggerTarget(
  configFile: string,
  outDir: string,
  config: NeemNormalizedConfig,
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
): NeemRolldownOptions | undefined {
  return plugins.reduce<NeemRolldownOptions | undefined>(
    (merged, plugin) => mergeRolldownOptions(merged, plugin.rolldown),
    undefined,
  )
}

function createRuntimeNode(options: {
  configFile: string
  outDir: string
  name: string
  runtime: NeemRuntimeConfigBase
  pluginRolldown?: NeemRolldownOptions
}): RuntimeBuildNode {
  const runtimeDir = resolve(
    options.outDir,
    'runtime',
    sanitizePathPart(options.name),
  )
  const workerEntry = options.runtime.worker
    ? resolveRequiredBuildEntry(
        options.configFile,
        options.runtime.worker.entry,
      )
    : undefined
  const hostEntry = resolveBuildEntry(
    options.configFile,
    options.runtime.host?.entry,
  )
  const artifacts = createRuntimeArtifactTargets({
    configFile: options.configFile,
    runtimeDir,
    runtimeName: options.name,
    artifacts: options.runtime.artifacts,
  })
  if (!workerEntry && !hostEntry) {
    throw new Error(
      `Runtime [${options.name}] must configure a worker or host entry`,
    )
  }

  return {
    name: options.name,
    config: options.runtime,
    worker: workerEntry
      ? {
          key: `runtime:${options.name}:worker`,
          kind: 'runtime-worker',
          artifact: {
            id: 'entry',
            kind: 'worker',
            entry: workerEntry,
            rolldown: mergeRolldownOptions(
              options.pluginRolldown,
              options.runtime.worker?.build?.rolldown,
            ),
          },
          owner: { type: 'runtime', name: options.name },
          outDir: resolve(runtimeDir, 'worker'),
        }
      : undefined,
    host: hostEntry
      ? {
          key: `runtime:${options.name}:host`,
          kind: 'runtime-host',
          artifact: {
            id: 'host',
            kind: 'module',
            entry: hostEntry,
            rolldown: options.runtime.host?.build?.rolldown,
          },
          owner: { type: 'runtime', name: options.name },
          outDir: resolve(runtimeDir, 'host'),
        }
      : undefined,
    artifacts,
  }
}

function createRuntimeArtifactTargets(options: {
  configFile: string
  runtimeDir: string
  runtimeName: string
  artifacts: readonly NeemArtifact[] | undefined
}): readonly BuildTarget[] {
  return (options.artifacts ?? []).map((artifact, index) => {
    const key = `${String(index).padStart(3, '0')}-${sanitizePathPart(artifact.id)}`

    return {
      key: `runtime:${options.runtimeName}:artifact:${key}`,
      kind: 'runtime-artifact',
      artifact: {
        id: artifact.id,
        kind: artifact.kind,
        entry: resolveRequiredBuildEntry(options.configFile, artifact.entry),
        ...(artifact.rolldown ? { rolldown: artifact.rolldown } : {}),
      },
      owner: { type: 'runtime', name: options.runtimeName },
      outDir: resolve(options.runtimeDir, 'artifacts', key),
    } satisfies BuildTarget
  })
}
