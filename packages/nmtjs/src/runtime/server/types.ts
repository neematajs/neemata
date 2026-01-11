import type EventEmitter from 'node:events'
import type { Worker } from 'node:worker_threads'

/**
 * Run options for the ApplicationServer.
 */
export type ApplicationServerRunOptions = {
  applications: string[]
  scheduler: boolean
  jobs: boolean
}

/**
 * Minimal event map required for worker management.
 * The events emitter may have additional events (like 'hmr-update').
 */
export type WorkerEventMap = { worker: [Worker]; [key: string]: any[] }

/**
 * Configuration for worker management in ApplicationServer.
 */
export type ApplicationServerWorkerConfig = {
  path: string
  workerData?: any
  worker?: (worker: Worker) => any
  events?: EventEmitter<WorkerEventMap>
}
