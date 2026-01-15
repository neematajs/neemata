import { workerData } from 'node:worker_threads'

import type { ServerConfig } from '../runtime/index.ts'
import type { RunWorkerOptions } from './thread.ts'
import {
  ApplicationWorkerRuntime,
  isApplicationConfig,
  JobWorkerRuntime,
} from '../runtime/index.ts'

/**
 * Worker entry point.
 *
 * Handles initialization of application or job worker runtimes.
 * Includes HMR supersede logic for application workers.
 */
export async function run(options: RunWorkerOptions['runtime']) {
  const serverConfig: ServerConfig = await import(
    // @ts-expect-error
    '#server'
  ).then((m) => m.default)

  if (options.type === 'application') {
    return initializeApplicationWorker(options, serverConfig)
  } else if (options.type === 'jobs') {
    return initializeJobWorker(options, serverConfig)
  } else {
    throw new Error(`Unknown runtime type: ${(options as any).type}`)
  }
}

/**
 * Initialize an application worker with HMR support.
 */
async function initializeApplicationWorker(
  options: Extract<RunWorkerOptions['runtime'], { type: 'application' }>,
  serverConfig: ServerConfig,
) {
  const { name, path, transportsData } = options

  // Load initial application config
  const appConfig = await import(
    /* @vite-ignore */
    path
  ).then((m) => m.default)

  if (!isApplicationConfig(appConfig)) {
    throw new Error(`Invalid application config for application: ${name}`)
  }

  // Create runtime
  const runtime = new ApplicationWorkerRuntime(
    serverConfig,
    { name, path, transports: transportsData },
    appConfig,
  )

  // Set up HMR with supersede logic
  setupApplicationHMR(runtime)

  return runtime
}

/**
 * Set up HMR acceptance for application config changes with supersede logic.
 *
 * When a reload is in progress and another HMR event arrives, the pending
 * reload is superseded - only the most recent config is applied.
 */
function setupApplicationHMR(runtime: ApplicationWorkerRuntime) {
  const logger = runtime.logger.child({ component: 'HMR' })

  // Track active reload
  let activeReload: Promise<void> | null = null

  // Track pending reload (supersedes previous pending)
  let pendingConfig: unknown | null = null
  let pendingResolve: (() => void) | null = null
  let pendingReject: ((e: Error) => void) | null = null

  /**
   * Execute a reload with the given config.
   */
  const executeReload = async (config: any): Promise<void> => {
    activeReload = doReload(config)

    try {
      await activeReload
    } finally {
      activeReload = null

      // If there's a pending reload, execute it now
      if (pendingConfig !== null) {
        const config = pendingConfig
        const resolve = pendingResolve!
        const reject = pendingReject!

        pendingConfig = null
        pendingResolve = null
        pendingReject = null

        executeReload(config).then(resolve, reject)
      }
    }
  }

  /**
   * Perform the actual reload.
   */
  const doReload = async (config: any): Promise<void> => {
    try {
      logger.debug('Reloading application...')
      await runtime.reload(config)
      logger.info('Application reloaded successfully')
    } catch (error) {
      // Log error but keep worker alive for next HMR update
      logger.error(new Error('Error during HMR reload', { cause: error }))
    }
  }

  /**
   * Schedule a reload. If reload is in progress, supersedes any pending.
   */
  const scheduleReload = (config: any): Promise<void> => {
    // If no active reload, execute immediately
    if (!activeReload) {
      return executeReload(config)
    }

    logger.debug('Reload in progress, queuing update...')
    // Supersede any existing pending reload
    if (pendingResolve) {
      logger.debug('Superseding previous pending reload')
      pendingResolve() // Resolve old pending (it's superseded)
    }

    // Create new pending
    return new Promise((resolve, reject) => {
      pendingConfig = config
      pendingResolve = resolve
      pendingReject = reject
    })
  }

  // Register global hot accept handler
  globalThis._hotAccept = async (module: any) => {
    logger.debug('Received HMR update')
    if (!module) return

    if (!isApplicationConfig(module.default)) {
      logger.error(new Error('Invalid application config during HMR reload'))
      return
    }

    await scheduleReload(module.default)
  }
}

/**
 * Initialize a job worker.
 */
async function initializeJobWorker(
  options: Extract<RunWorkerOptions['runtime'], { type: 'jobs' }>,
  serverConfig: ServerConfig,
) {
  const { jobWorkerPool } = options
  const runtime = new JobWorkerRuntime(serverConfig, {
    poolName: jobWorkerPool,
    port: workerData.port,
  })
  return runtime
}
