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
import {
  applyMetricsServerEnvOverrides,
  formatAppliedMetricsEnvOverride,
} from './env.ts'
import { createNeemMetricsLifecycle } from './observer.ts'

type MetricsPluginOptions = { server?: MetricsServerConfig }

export default definePluginHooks((ctx) => {
  const options = parseOptions(ctx.options)
  // Options were frozen into the manifest at build time; the factory runs at
  // start, so the live environment gets the final say on server/push knobs.
  const overrides = applyMetricsServerEnvOverrides(options.server, process.env)
  for (const override of overrides.applied)
    ctx.logger.info(formatAppliedMetricsEnvOverride(override))
  for (const warning of overrides.warnings) ctx.logger.warn(warning)
  const registry = createMetricsRegistry()
  const workerRegistry = createMetricsWorkerRegistry({ primary: true })
  const lifecycle = createNeemMetricsLifecycle({
    registry,
    getHealth: ctx.getHealth,
  })
  const server = createMetricsServer({
    logger: ctx.logger,
    config: overrides.config,
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
