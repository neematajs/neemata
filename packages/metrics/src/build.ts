const defaultMetricsLoaderId = '@nmtjs/metrics/default-loader'

export type DefaultMetricsRolldownPluginOptions = {
  include?: RegExp | ((id: string) => boolean)
}

export function createDefaultMetricsRolldownPlugin(
  options: DefaultMetricsRolldownPluginOptions = {},
): object {
  const shouldInject = createMatcher(options.include)

  return {
    name: 'nmtjs-metrics-default-loader',
    resolveId(id: string) {
      return id === defaultMetricsLoaderId ? id : undefined
    },
    load(id: string) {
      if (id !== defaultMetricsLoaderId) return undefined
      return "import { registerDefaultMetrics } from '@nmtjs/metrics'; registerDefaultMetrics();"
    },
    transform(code: string, id: string) {
      if (id === defaultMetricsLoaderId || !shouldInject(id)) return undefined
      return `import ${JSON.stringify(defaultMetricsLoaderId)};\n${code}`
    },
  }
}

export function getDefaultMetricsLoaderImport(): string {
  return defaultMetricsLoaderId
}

function createMatcher(
  include: DefaultMetricsRolldownPluginOptions['include'],
): (id: string) => boolean {
  if (!include) return () => false
  if (include instanceof RegExp) return (id) => include.test(id)
  return include
}
