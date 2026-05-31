import { definePluginHooks } from '@nmtjs/neem'

import type { MetricsServerConfig } from '../server.ts'
import {
  createMetricsRegistry,
  createMetricsWorkerRegistry,
} from '../registry.ts'
import {
  createCombinedMetricsCollector,
  createMetricsServer,
} from '../server.ts'
import { createNeemMetricsLifecycle } from './observer.ts'

type MetricsPluginOptions = { server?: MetricsServerConfig }

export default definePluginHooks((ctx) => {
  const options = parseOptions(ctx.options)
  const registry = createMetricsRegistry()
  const workerRegistry = createMetricsWorkerRegistry({ primary: true })
  const lifecycle = createNeemMetricsLifecycle({
    registry,
    getHealth: ctx.getHealth,
  })
  const server = createMetricsServer({
    logger: ctx.logger,
    config: options.server,
    registry: createCombinedMetricsCollector(registry, workerRegistry),
  })

  return {
    ...lifecycle.hooks,
    async initialize() {
      await server.start()
      lifecycle.recordHealth()
    },
    async dispose() {
      await server.stop()
      registry.clear()
    },
  }
})

function parseOptions(options: unknown): MetricsPluginOptions {
  if (!isRecord(options)) return {}
  return {
    server: isRecord(options.server)
      ? (options.server as MetricsServerConfig)
      : undefined,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
