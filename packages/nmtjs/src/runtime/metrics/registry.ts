import {
  collectDefaultMetrics,
  register,
  WorkerRegistry,
} from '@nmtjs/prom-client'

export const workerRegistry = new WorkerRegistry()

export const registry = register

collectDefaultMetrics()
