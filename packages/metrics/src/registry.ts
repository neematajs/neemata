import {
  collectDefaultMetrics,
  Registry,
  register,
  WorkerRegistry,
} from '@nmtjs/prom-client'

export const metricsRegistry = register
export const metricsWorkerRegistry = new WorkerRegistry()

let defaultMetricsRegistered = false

export function createMetricsRegistry(): Registry {
  return new Registry()
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
