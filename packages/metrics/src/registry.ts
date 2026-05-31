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
  const Constructor = WorkerRegistry as unknown as new (
    contentType?: RegistryContentType,
    primary?: boolean,
  ) => WorkerRegistry<any>
  return new Constructor(options.contentType, options.primary)
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
