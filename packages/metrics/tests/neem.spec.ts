import { describe, expect, it } from 'vitest'

import metrics, { metricsPluginName } from '../src/neem/index.ts'

describe('@nmtjs/metrics/neem', () => {
  it('declares the Neem plugin entry, server options, and default metrics loader', () => {
    const plugin = metrics({
      server: { host: '127.0.0.1', port: 0, path: '/custom-metrics' },
    })

    expect(plugin).toMatchObject({
      name: metricsPluginName,
      entry: '@nmtjs/metrics/neem/plugin',
      options: {
        server: { host: '127.0.0.1', port: 0, path: '/custom-metrics' },
      },
      build: {
        rolldown: {
          plugins: [
            expect.objectContaining({ name: 'nmtjs-metrics-default-loader' }),
          ],
        },
      },
    })
    expect(Object.isFrozen(plugin)).toBe(true)
  })

  it('omits server options and default metrics loader when disabled', () => {
    const plugin = metrics({ defaultMetrics: false })

    expect(plugin).toEqual({
      name: metricsPluginName,
      entry: '@nmtjs/metrics/neem/plugin',
    })
  })
})
