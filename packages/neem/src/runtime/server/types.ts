import type EventEmitter from 'node:events'
import type { Worker } from 'node:worker_threads'

/**
 * Run options for the Neem application server.
 */
export type NeemServerRunOptions = { applications: string[] }

/**
 * Minimal event map required for worker management.
 * The events emitter may have additional events (like 'hmr-update').
 */
export type WorkerEventMap = { worker: [Worker]; [key: string]: any[] }

/**
 * Configuration for worker management in NeemServer.
 */
export type NeemServerWorkerConfig = {
  path: string
  workerData?: any
  worker?: (worker: Worker) => any
  events?: EventEmitter<WorkerEventMap>
}
