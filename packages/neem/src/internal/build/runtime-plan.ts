import type {
  NeemArtifact,
  NeemRolldownOptions,
} from '../../public/artifact.ts'
import type {
  NeemNormalizedConfig,
  NeemRuntimeConfigBase,
} from '../../public/config.ts'
import { resolveBuildEntry, resolveRequiredBuildEntry } from './resolve.ts'
import { assertSelectedRuntimeNamesExist } from './runtime-selection.ts'
import { mergeNeemRolldownOptions } from './utils.ts'

export type NeemRuntimeBuildPlan = {
  name: string
  worker: {
    entry: NeemArtifact['entry']
    rolldown?: NeemRolldownOptions
    artifacts?: readonly NeemArtifact[]
  }
  host?: { entry: NeemArtifact['entry']; rolldown?: NeemRolldownOptions }
}

export function resolveRuntimeBuildPlans(
  configFile: string,
  config: NeemNormalizedConfig,
  selectedRuntimes: readonly string[] | undefined,
  options: { rolldown?: NeemRolldownOptions } = {},
): readonly NeemRuntimeBuildPlan[] {
  const runtimeEntries = Object.entries(config.runtimes ?? {})
  assertSelectedRuntimeNamesExist(
    selectedRuntimes,
    runtimeEntries.map(([name]) => name),
  )
  const selected = selectedRuntimes ? new Set(selectedRuntimes) : undefined

  return runtimeEntries
    .filter(([name]) => !selected || selected.has(name))
    .map(([name, runtimeConfig]) =>
      resolveRuntimeBuildPlan(configFile, name, runtimeConfig, options),
    )
}

function resolveRuntimeBuildPlan(
  configFile: string,
  name: string,
  runtimeConfig: NeemRuntimeConfigBase,
  options: { rolldown?: NeemRolldownOptions } = {},
): NeemRuntimeBuildPlan {
  const entry = resolveRequiredBuildEntry(
    configFile,
    runtimeConfig.worker.entry,
  )
  const artifacts = resolveRuntimeBuildArtifacts(
    configFile,
    runtimeConfig.artifacts,
  )
  const hostEntry = resolveBuildEntry(configFile, runtimeConfig.host?.entry)

  return {
    name,
    worker: {
      entry,
      rolldown: mergeNeemRolldownOptions(
        options.rolldown,
        runtimeConfig.worker.build?.rolldown,
      ),
      artifacts,
    },
    host: hostEntry
      ? { entry: hostEntry, rolldown: runtimeConfig.host?.build?.rolldown }
      : undefined,
  }
}

function resolveRuntimeBuildArtifacts(
  importer: string,
  artifacts: readonly NeemArtifact[] | undefined,
): readonly NeemArtifact[] | undefined {
  return artifacts?.map((artifact) => ({
    ...artifact,
    entry: resolveRequiredBuildEntry(importer, artifact.entry),
  }))
}
