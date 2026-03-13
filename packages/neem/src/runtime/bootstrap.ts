import { createLogger } from '@nmtjs/core'

import type {
  NeemPoolEnvironmentOrchestrator,
  NeemServerWorkerConfig,
} from '../types.ts'
import type { NeemApplicationConfig, NeemServerConfig } from './config.ts'
import { createRuntimeEnvironment } from './environment.ts'
import { HMRCoordinator } from './hmr-coordinator.ts'
import { ServerLifecycle } from './lifecycle.ts'
import { NeemServer } from './server.ts'

export interface StartNeemServerOptions {
  config: NeemServerConfig
  applicationsConfig: Record<string, NeemApplicationConfig>
  workerConfig: NeemServerWorkerConfig
  mode: 'development' | 'production'
  moduleLoader: 'runner' | 'native'
  onLifecycleError?: (error: Error, handled: boolean) => void
  setupProcessHandlers?: boolean
  poolEnvironmentOrchestrator?: NeemPoolEnvironmentOrchestrator
}

export async function startNeemServer(options: StartNeemServerOptions) {
  const logger = createLogger(options.config.logger, 'NeemMain')

  const env = createRuntimeEnvironment(options.mode)
  const poolEnvironmentOrchestrator =
    options.poolEnvironmentOrchestrator ??
    (await createDefaultPoolEnvironmentOrchestrator(
      options.mode,
      options.moduleLoader,
      logger,
    ))

  const createServer = () =>
    new NeemServer(
      {
        config: options.config,
        applications: options.applicationsConfig,
        worker: options.workerConfig,
        mode: options.mode,
      },
      poolEnvironmentOrchestrator,
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

async function createDefaultPoolEnvironmentOrchestrator(
  mode: 'development' | 'production',
  moduleLoader: 'runner' | 'native',
  logger: ReturnType<typeof createLogger>,
): Promise<NeemPoolEnvironmentOrchestrator | undefined> {
  if (moduleLoader !== 'runner') {
    return undefined
  }

  const { VitePoolOrchestrator } = await import('../vite/orchestrator.ts')

  return new VitePoolOrchestrator({ mode, logger })
}
