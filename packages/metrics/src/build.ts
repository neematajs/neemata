import { fileURLToPath } from 'node:url'

import type { RolldownPluginOption } from '@nmtjs/neem'

const PackageNotFoundError = new Error(
  '"@nmtjs/metrics" package is not found. Make sure it is installed as package.json dependency',
)

export function createDefaultMetricsRolldownPlugin(): RolldownPluginOption {
  return {
    name: 'nmtjs-metrics-default-loader',
    async transform(this, code, id) {
      if (this.getModuleInfo?.(id)?.isEntry) {
        const metricsPackage =
          (await this.resolve('@nmtjs/metrics')) ??
          fileURLToPath(new URL('./index.js', import.meta.url))
        if (!metricsPackage) throw PackageNotFoundError
        const file = await this.load({
          id:
            typeof metricsPackage === 'string'
              ? metricsPackage
              : metricsPackage.id,
        })
        const lines = [
          `import { registerDefaultMetrics } from ${JSON.stringify(file.id)}`,
          'registerDefaultMetrics()',
          code,
        ]
        const map = this.getCombinedSourcemap()
        return {
          code: lines.join('\n'),
          map: { ...map, mappings: `;;${map.mappings}` },
        }
      }
    },
  }
}
