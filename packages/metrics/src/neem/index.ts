import type { NeemPluginInput } from '@nmtjs/neem'
import { definePlugin } from '@nmtjs/neem'

import type { MetricsServerConfig } from '../server.ts'
import { createDefaultMetricsRolldownPlugin } from '../build.ts'

export type NeemMetricsPluginOptions = {
  server?: MetricsServerConfig
  defaultMetrics?: boolean
}

export const metricsPluginName = '@nmtjs/metrics'

export default function metrics(
  options: NeemMetricsPluginOptions = {},
): NeemPluginInput {
  const defaultMetrics = options.defaultMetrics ?? true

  return definePlugin({
    name: metricsPluginName,
    entry: '@nmtjs/metrics/neem/plugin',
    ...(options.server ? { options: { server: options.server } } : {}),
    ...(defaultMetrics
      ? {
          build: {
            rolldown: { plugins: [createDefaultMetricsRolldownPlugin()] },
          },
        }
      : {}),
  })
}

export * from './observer.ts'
