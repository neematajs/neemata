import { collectDefaultMetrics, register, WorkerRegistry } from 'prom-client'

export const workerRegistry = new WorkerRegistry()

export const registry = register

collectDefaultMetrics()
