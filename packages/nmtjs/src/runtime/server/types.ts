import type EventEmitter from 'node:events'
import type { MessagePort, Worker } from 'node:worker_threads'

/**
 * Run options for the ApplicationServer.
 */
export type ApplicationServerRunOptions = {
  applications: string[]
  scheduler: boolean
  jobs: boolean
}

export type WorkerRegistration = { worker: Worker; vitePort?: MessagePort }

/**
 * Minimal event map required for worker management.
 * The events emitter may have additional events (like 'hmr-update').
 */
export type WorkerEventMap = {
  worker: [registration: WorkerRegistration]
  [key: string]: any[]
}

/**
 * Configuration for worker management in ApplicationServer.
 */
export type ApplicationServerWorkerConfig = {
  path: string
  workerData?: any
  worker?: (registration: WorkerRegistration) => any
  events?: EventEmitter<WorkerEventMap>
}
