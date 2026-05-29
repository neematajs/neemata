import type {
  NeemArtifact,
  NeemRolldownOptions,
} from '../../public/artifact.ts'
import type {
  NeemNormalizedConfig,
  NeemRuntimeConfigBase,
} from '../../public/config.ts'
import { mergeNeemRolldownOptions } from '../../public/rolldown-options.ts'
import { resolveBuildEntry, resolveRequiredBuildEntry } from './resolve.ts'

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

  return runtimeEntries
    .filter(([name]) => shouldUseRuntimeName(name, selectedRuntimes))
    .map(([name, runtimeConfig]) =>
      resolveRuntimeBuildPlan(configFile, name, runtimeConfig, options),
    )
}

export function resolveRuntimeBuildPlan(
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

export function normalizeSelectedRuntimeNames(
  runtimes: readonly string[] | undefined,
): readonly string[] | undefined {
  const selected = runtimes?.map((runtime) => runtime.trim()).filter(Boolean)
  return selected && selected.length > 0 ? [...new Set(selected)] : undefined
}

export function shouldUseRuntimeName(
  name: string,
  selected: readonly string[] | undefined,
): boolean {
  return !selected || selected.includes(name)
}

export function assertSelectedRuntimeNamesExist(
  selected: readonly string[] | undefined,
  available: readonly string[],
): void {
  if (!selected) return
  const missing = selected.filter((name) => !available.includes(name))
  if (missing.length > 0) {
    throw new Error(`Unknown Neem runtime(s): ${missing.join(', ')}`)
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
