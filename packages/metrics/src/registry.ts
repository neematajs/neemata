import type { RegistryContentType } from '@nmtjs/prom-client'
import {
  collectDefaultMetrics,
  Registry,
  register,
  WorkerRegistry,
} from '@nmtjs/prom-client'

export const metricsRegistry = register
export const metricsWorkerRegistry = createMetricsWorkerRegistry()

let defaultMetricsRegistered = false

export function createMetricsRegistry(): Registry {
  return new Registry()
}

export function createMetricsWorkerRegistry(
  options: { primary?: boolean; contentType?: RegistryContentType } = {},
): WorkerRegistry<any> {
  return new WorkerRegistry(options.contentType, options.primary)
}

export function registerDefaultMetrics(
  registry: Registry = metricsRegistry,
): void {
  if (registry === metricsRegistry) {
    if (defaultMetricsRegistered) return
    defaultMetricsRegistered = true
  }
  collectDefaultMetrics({ register: registry })
}
