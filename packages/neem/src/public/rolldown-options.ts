import type { NeemRolldownOptions } from './artifact.ts'

const OUTPUT_ARRAY_ERROR =
  'Neem Rolldown output arrays are not supported; configure a single output object.'

export function mergeNeemRolldownOptions(
  ...layers: readonly (NeemRolldownOptions | undefined)[]
): NeemRolldownOptions | undefined {
  let result: NeemRolldownOptions | undefined
  let output: Record<string, unknown> | undefined
  const plugins: NonNullable<NeemRolldownOptions['plugins']>[] = []

  for (const layer of layers) {
    if (!layer) continue

    const layerOutput = normalizeRolldownOutput(layer.output)
    result = { ...(result ?? {}), ...layer }
    plugins.push(...normalizeRolldownPlugins(layer.plugins))

    if (layerOutput) {
      output = { ...(output ?? {}), ...layerOutput }
    }
  }

  if (!result) return undefined

  if (plugins.length > 0) {
    result.plugins = plugins
  } else if ('plugins' in result) {
    result.plugins = undefined
  }

  if (output) {
    result.output = output as NeemRolldownOptions['output']
  }

  return result
}

function normalizeRolldownOutput(
  output: NeemRolldownOptions['output'] | undefined,
): Record<string, unknown> | undefined {
  if (Array.isArray(output)) {
    throw new Error(OUTPUT_ARRAY_ERROR)
  }

  if (!output || typeof output !== 'object') return undefined
  return { ...(output as Record<string, unknown>) }
}

function normalizeRolldownPlugins(
  plugins: NeemRolldownOptions['plugins'] | undefined,
): NonNullable<NeemRolldownOptions['plugins']>[] {
  if (!plugins) return []
  return (Array.isArray(plugins) ? plugins : [plugins]).filter(
    (plugin): plugin is NonNullable<typeof plugin> => plugin !== undefined,
  )
}
