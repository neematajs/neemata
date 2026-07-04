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
  // @nmtjs/prom-client's typings declare no constructor for WorkerRegistry, so
  // the inferred zero-arg signature rejects the (contentType, primary) arguments
  // the runtime constructor actually accepts. Assert the real signature.
  const Constructor = WorkerRegistry as new (
    contentType?: RegistryContentType,
    primary?: boolean,
  ) => WorkerRegistry<RegistryContentType>
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
