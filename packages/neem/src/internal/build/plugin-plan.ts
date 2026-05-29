import type { NeemRolldownOptions } from '../../public/artifact.ts'
import type {
  NeemNormalizedConfig,
  NeemPluginInput,
} from '../../public/config.ts'
import { mergeNeemRolldownOptions } from '../../public/rolldown-options.ts'
import { resolveBuildEntry } from './resolve.ts'

export type NeemPluginBuildPlan = {
  key: string
  index: number
  name: string
  entry?: string | URL
  rolldown?: NeemRolldownOptions
  options?: unknown
}

export function resolvePluginBuildPlans(
  configFile: string,
  config: Pick<NeemNormalizedConfig, 'plugins'>,
): readonly NeemPluginBuildPlan[] {
  return (config.plugins ?? []).map((plugin, index) =>
    resolvePluginBuildPlan(configFile, plugin, index),
  )
}

export function mergePluginRolldownOptions(
  plugins: readonly NeemPluginBuildPlan[],
): NeemRolldownOptions | undefined {
  return plugins.reduce<NeemRolldownOptions | undefined>(
    (merged, plugin) => mergeNeemRolldownOptions(merged, plugin.rolldown),
    undefined,
  )
}

function resolvePluginBuildPlan(
  configFile: string,
  plugin: NeemPluginInput,
  index: number,
): NeemPluginBuildPlan {
  const name = plugin.name.trim()
  if (!name) {
    throw new Error(`Neem plugin at index [${index}] must have a name`)
  }

  return {
    key: `${String(index).padStart(3, '0')}-${sanitizePathPart(name)}`,
    index,
    name,
    entry: resolveBuildEntry(configFile, plugin.entry),
    rolldown: plugin.build?.rolldown,
    options: plugin.options,
  }
}

function sanitizePathPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'plugin'
  )
}
