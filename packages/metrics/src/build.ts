import type { RolldownPluginOption } from '@nmtjs/neem'

const PackageNotFoundError = new Error(
  '"@nmtjs/metrics" package is not found. Make sure it is installed as package.json dependency',
)

export function createDefaultMetricsRolldownPlugin(): RolldownPluginOption {
  return {
    name: 'nmtjs-metrics-default-loader',
    async transform(this, code, id) {
      if (this.getModuleInfo?.(id)?.isEntry) {
        const metricsPackage = await this.resolve('@nmtjs/metrics')
        if (!metricsPackage) throw PackageNotFoundError
        const file = await this.load({ id: metricsPackage.id })
        const lines = [
          `import { registerDefaultMetrics } from ${JSON.stringify(file.id)}`,
          'registerDefaultMetrics()',
          code,
        ]
        return lines.join('\n')
      }
    },
  }
}
