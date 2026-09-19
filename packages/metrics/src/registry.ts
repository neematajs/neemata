import type { RegistryContentType } from '@nmtjs/prom-client'
import {
  collectDefaultMetrics,
  Registry,
  register,
  WorkerRegistry,
} from '@nmtjs/prom-client'

export const metricsRegistry = register
export const metricsWorkerRegistry = createMetricsWorkerRegistry()

// only the shared registry is guarded: it is registered from several entry
// points, while a custom registry may be cleared and registered again
let defaultRegistered = false

export function createMetricsRegistry(): Registry {
  return new Registry()
}

export function createMetricsWorkerRegistry(
  options: { primary?: boolean; contentType?: RegistryContentType } = {},
): WorkerRegistry<RegistryContentType> {
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
    if (defaultRegistered) return
    defaultRegistered = true
  }
  collectDefaultMetrics({ register: registry })
}
