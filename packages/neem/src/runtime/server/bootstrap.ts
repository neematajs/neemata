import { createLogger } from '@nmtjs/core'

import type { NeemServerConfig } from './config.ts'
import type { ErrorPolicy } from './error-policy.ts'
import type { NeemServerWorkerConfig } from './types.ts'
import type { ManagedWorkerFactory, WorkerPoolFactory } from './worker-pool.ts'
import { createRuntimeEnvironment } from './environment.ts'
import { getErrorPolicy } from './error-policy.ts'
import { HMRCoordinator } from './hmr-coordinator.ts'
import { ServerLifecycle } from './lifecycle.ts'
import {
  defaultPoolFactory,
  defaultWorkerFactory,
  NeemServer,
} from './server.ts'

export interface StartNeemServerOptions {
  config: NeemServerConfig
  applicationsConfig: Record<string, { specifier: string }>
  workerConfig: NeemServerWorkerConfig
  mode: 'development' | 'production'
  onLifecycleError?: (error: Error, handled: boolean) => void
  setupProcessHandlers?: boolean
  errorPolicy?: ErrorPolicy
  workerFactory?: ManagedWorkerFactory
  poolFactory?: WorkerPoolFactory
}

export async function startNeemServer(options: StartNeemServerOptions) {
  const errorPolicy = options.errorPolicy ?? getErrorPolicy(options.mode)
  const logger = createLogger(options.config.logger, 'NeemMain')

  const env = createRuntimeEnvironment(options.mode)
  const createServer = () =>
    new NeemServer(
      options.config,
      options.applicationsConfig,
      options.workerConfig,
      undefined,
      options.mode,
      errorPolicy,
      options.workerFactory ?? defaultWorkerFactory,
      options.poolFactory ?? defaultPoolFactory,
    )

  const lifecycle = new ServerLifecycle(env, createServer, logger)
  const hmr =
    options.mode === 'development'
      ? new HMRCoordinator(lifecycle, logger)
      : null

  if (options.onLifecycleError) {
    lifecycle.on('error', options.onLifecycleError)
  }

  let isTerminating = false

  const shutdown = async () => {
    if (isTerminating) return
    isTerminating = true

    try {
      await lifecycle.stop()
    } catch (error) {
      logger.error(
        new Error('Failed to stop neem server', { cause: error as Error }),
      )
    }
  }

  if (options.setupProcessHandlers) {
    process.once('SIGTERM', () => {
      void shutdown()
    })
    process.once('SIGINT', () => {
      void shutdown()
    })
  }

  await lifecycle.start()

  return {
    lifecycle,
    hmr,
    stop: shutdown,
    restartFailedWorkers: async () => {
      const server = lifecycle.getServer()
      if (!server || !(server instanceof NeemServer)) return 0
      return await server.restartFailedWorkers()
    },
  }
}
