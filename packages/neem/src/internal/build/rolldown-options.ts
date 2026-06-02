import type { NeemRolldownOptions } from '../../public/artifact.ts'

const OUTPUT_ARRAY_ERROR =
  'Neem Rolldown output arrays are not supported; configure a single output object.'

export function mergeRolldownOptions(
  ...layers: readonly (NeemRolldownOptions | undefined)[]
): NeemRolldownOptions | undefined {
  let result: NeemRolldownOptions | undefined
  let output: Record<string, unknown> | undefined
  const plugins: NonNullable<NeemRolldownOptions['plugins']>[] = []

  for (const layer of layers) {
    if (!layer) continue

    const layerOutput = normalizeOutput(layer.output)
    result = { ...(result ?? {}), ...layer }
    plugins.push(...normalizePlugins(layer.plugins))

    if (layerOutput) output = { ...(output ?? {}), ...layerOutput }
  }

  if (!result) return undefined

  result.plugins = plugins.length > 0 ? plugins : undefined
  if (output) result.output = output as NeemRolldownOptions['output']
  result.transform = {
    ...result.transform,
    define: {
      'import.meta.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    }
  }
  return result
}

function normalizeOutput(
  output: NeemRolldownOptions['output'] | undefined,
): Record<string, unknown> | undefined {
  if (Array.isArray(output)) throw new Error(OUTPUT_ARRAY_ERROR)
  if (!output || typeof output !== 'object') return undefined
  return { ...(output as Record<string, unknown>) }
}

function normalizePlugins(
  plugins: NeemRolldownOptions['plugins'] | undefined,
): NonNullable<NeemRolldownOptions['plugins']>[] {
  if (!plugins) return []
  return (Array.isArray(plugins) ? plugins : [plugins]).filter(
    (plugin): plugin is NonNullable<typeof plugin> => plugin !== undefined,
  )
}
