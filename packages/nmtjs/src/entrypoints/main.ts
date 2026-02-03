import type { Worker } from 'node:worker_threads'
import EventEmitter from 'node:events'
import { fileURLToPath } from 'node:url'

import type { ViteDevServer } from 'vite'
import { createLogger } from '@nmtjs/core'

import type { ServerConfig } from '../runtime/index.ts'
import type { WorkerServerEventMap } from '../vite/servers/worker.ts'
import {
  ApplicationServer,
  defaultPoolFactory,
  defaultWorkerFactory,
  isServerConfig,
} from '../runtime/index.ts'
import { createRuntimeEnvironment } from '../runtime/server/environment.ts'
import { getErrorPolicy } from '../runtime/server/error-policy.ts'
import { HMRCoordinator } from '../runtime/server/hmr-coordinator.ts'
import { ServerLifecycle } from '../runtime/server/lifecycle.ts'

declare global {
  const __VITE_CONFIG__: string
  const __APPLICATIONS_CONFIG__: string
}

class InvalidServerConfigError extends Error {
  constructor() {
    super(
      `Server config file does not have a default export, or it is not a valid server config. Please, make sure the server config is defined using defineServer().`,
    )
    this.name = 'InvalidServerConfigError'
  }
}

const _ext = new URL(import.meta.url).pathname.endsWith('.ts') ? '.ts' : '.js'
const _vite = __VITE_CONFIG__ ? JSON.parse(__VITE_CONFIG__) : undefined
const applicationsConfig: Record<
  string,
  { type: 'neemata' | 'custom'; specifier: string }
> = __APPLICATIONS_CONFIG__ ? JSON.parse(__APPLICATIONS_CONFIG__) : {}

// Runtime environment setup
const mode = _vite?.mode === 'development' ? 'development' : 'production'
const isDev = mode === 'development'
const errorPolicy = getErrorPolicy(mode)

// Logger for main process (created lazily with config-based level)
let logger: ReturnType<typeof createLogger>

// Vite server and events (dev only)
let _viteServerEvents: EventEmitter<WorkerServerEventMap> | undefined
let _viteServer: ViteDevServer | undefined

// Server lifecycle management
let lifecycle: ServerLifecycle | undefined
let hmrCoordinator: HMRCoordinator | undefined

// Current server config (updated on HMR)
let currentServerConfig: ServerConfig | undefined

// Track termination state
let isTerminating = false

/**
 * Create the ApplicationServer instance using currentServerConfig.
 */
function createServer(): ApplicationServer {
  if (!currentServerConfig) {
    throw new Error('Server config not initialized')
  }

  const workerConfig = {
    path: fileURLToPath(new URL(`./thread${_ext}`, import.meta.url)),
    workerData: { vite: _vite?.mode },
    worker: _viteServerEvents
      ? (worker: Worker) => {
          _viteServerEvents!.emit('worker', worker)
        }
      : undefined,
    events: _viteServerEvents,
  }

  return new ApplicationServer(
    currentServerConfig,
    applicationsConfig,
    workerConfig,
    undefined, // runOptions
    errorPolicy,
    defaultWorkerFactory,
    defaultPoolFactory,
  )
}

/**
 * Initialize Vite dev server (dev mode only).
 */
async function initializeVite() {
  if (!_vite) return

  const { createViteServer } = await import('../vite/servers/worker.ts')
  const neemataConfig = await import(
    /* @vite-ignore */
    _vite.options.configPath
  ).then((m) => m.default as import('../config.ts').NeemataConfig)

  _viteServerEvents = new EventEmitter<WorkerServerEventMap>()
  _viteServerEvents.on('hmr-update', handleHMRUpdate)

  _viteServer = await createViteServer(
    _vite.options,
    _vite.mode,
    neemataConfig,
    _viteServerEvents,
  )
}

/**
 * Initialize the server lifecycle (called once at startup).
 */
function initializeLifecycle(configValue: ServerConfig) {
  if (!isServerConfig(configValue)) throw new InvalidServerConfigError()

  // Store initial config
  currentServerConfig = configValue
  const loggerOptions = currentServerConfig?.logger ?? {
    pinoOptions: { level: isDev ? 'debug' : 'info' },
  }
  logger = createLogger(loggerOptions, 'Main')

  // Create runtime environment
  const env = createRuntimeEnvironment(mode, {
    vite: _viteServer ?? undefined,
    hmr: undefined, // hmrCoordinator created after lifecycle
  })

  // Create lifecycle (singleton)
  lifecycle = new ServerLifecycle(env, createServer, logger)

  // Create HMR coordinator (dev only, singleton)
  if (isDev) {
    hmrCoordinator = new HMRCoordinator(lifecycle, logger)
  }

  // Listen for lifecycle errors (once)
  lifecycle.on('error', (error, handled) => {
    if (!handled) {
      logger.error(new Error('Unhandled lifecycle error', { cause: error }))
    }
  })
}

/**
 * Set up HMR acceptance for server config changes.
 */
function setupHMR() {
  if (!import.meta.env.DEV || !import.meta.hot) return

  import.meta.hot.accept('#server', async (module) => {
    if (!module) return
    if (!isServerConfig(module.default)) throw new InvalidServerConfigError()

    // Update the config (createServer will use this on next reload)
    currentServerConfig = module.default

    // Use HMR coordinator to handle the reload
    if (hmrCoordinator) {
      try {
        await hmrCoordinator.scheduleReload()
      } catch (cause) {
        logger.error(new Error('Error during HMR reload', { cause }))
      }
    }
  })
}

/**
 * Handle HMR update event.
 * When an application file is updated and there are failed workers, restart them.
 */
async function handleHMRUpdate(_event: { file: string }) {
  // If server is in failed state, try to start it
  if (lifecycle?.currentState === 'failed') {
    try {
      await lifecycle.start()
    } catch {
      // Error will be handled by lifecycle
    }
    return
  }

  // If server is running, restart any failed workers
  const server = lifecycle?.getServer()
  if (server) {
    try {
      const restarted = await server.restartFailedWorkers()
      if (restarted > 0) {
        logger.info(
          { count: restarted },
          'Restarted failed workers after HMR update',
        )
      }
    } catch (error) {
      logger.error(
        new Error('Failed to restart workers after HMR update', {
          cause: error,
        }),
      )
    }
  }
}

/**
 * Handle startup error.
 */
function handleStartupError(error: unknown) {
  const normalized = error instanceof Error ? error : new Error(String(error))
  logger.error(
    new Error('Failed to start application server', { cause: normalized }),
  )
}

/**
 * Handle process termination signals.
 */
async function handleTermination() {
  if (isTerminating) return
  isTerminating = true

  logger.info('Shutting down...')

  try {
    await lifecycle?.stop()
  } catch (error) {
    logger.error(new Error('Failed to stop server', { cause: error as Error }))
  }

  _viteServer?.close()
  process.exit(0)
}

/**
 * Handle unexpected errors.
 */
function handleUnexpectedError(error: Error) {
  logger.error(new Error('Unexpected Error', { cause: error }))
}

/**
 * Main entry point.
 */
async function main() {
  // Set up process handlers
  process.once('SIGTERM', handleTermination)
  process.once('SIGINT', handleTermination)
  process.on('uncaughtException', handleUnexpectedError)
  process.on('unhandledRejection', handleUnexpectedError)

  // Initialize Vite (dev mode only)
  await initializeVite()

  // Load server config
  const serverConfig = await import(
    // @ts-expect-error
    '#server'
  ).then((m) => m.default)

  // Initialize lifecycle (sync, creates singletons)
  initializeLifecycle(serverConfig)

  // Set up HMR
  setupHMR()

  // Start the server
  try {
    await lifecycle!.start()
  } catch (error) {
    handleStartupError(error)
    if (!isDev) {
      process.exit(1)
    }
  }
}

main().catch((error) => {
  logger.fatal(new Error('Fatal error during startup', { cause: error }))
  if (!isDev) {
    process.exit(1)
  }
})
