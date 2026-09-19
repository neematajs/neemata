import { fileURLToPath } from 'node:url'

import type { RolldownPluginOption } from '@nmtjs/neem'

export function createDefaultMetricsRolldownPlugin(): RolldownPluginOption {
  return {
    name: 'nmtjs-metrics-default-loader',
    async transform(this, code, id) {
      if (!this.getModuleInfo?.(id)?.isEntry) return

      const resolved =
        (await this.resolve('@nmtjs/metrics')) ??
        fileURLToPath(new URL('./index.js', import.meta.url))
      const file = await this.load({
        id: typeof resolved === 'string' ? resolved : resolved.id,
      })
      const injected = [
        `import { registerDefaultMetrics } from ${JSON.stringify(file.id)}`,
        'registerDefaultMetrics()',
      ]
      const map = this.getCombinedSourcemap()

      return {
        code: [...injected, code].join('\n'),
        // one empty mapping group per injected line keeps the original code
        // aligned with its own mappings
        map: {
          ...map,
          mappings: `${';'.repeat(injected.length)}${map.mappings}`,
        },
      }
    },
  }
}
