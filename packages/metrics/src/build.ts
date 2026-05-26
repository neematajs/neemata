const defaultMetricsLoaderId = '@nmtjs/metrics/default-loader'

export function createDefaultMetricsRolldownPlugin(): object {
  return {
    name: 'nmtjs-metrics-default-loader',
    resolveId(id: string) {
      return id === defaultMetricsLoaderId ? id : undefined
    },
    load(id: string) {
      if (id !== defaultMetricsLoaderId) return undefined
      return "import { registerDefaultMetrics } from '@nmtjs/metrics'; registerDefaultMetrics();"
    },
  }
}

export function getDefaultMetricsLoaderImport(): string {
  return defaultMetricsLoaderId
}
