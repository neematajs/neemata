import { deepStrictEqual } from 'node:assert'

import type {
  ApplicationConfig,
  ApplicationConfigFactory,
} from '@nmtjs/application'
import type { ServerConfig } from '@nmtjs/server'
import {
  Application,
  ApplicationWorkerType,
  resolveApplicationConfig,
} from '@nmtjs/application'
import { createValueInjectable } from '@nmtjs/core'
import { JobManagerPlugin } from '@nmtjs/server'
import { ApplicationWorker } from '@nmtjs/server/worker'

import type { RunWorkerOptions } from './thread.ts'

const areConfigsEqual = (a: ApplicationConfig, b: ApplicationConfig) => {
  try {
    deepStrictEqual(a.logging, b.logging)
  } catch (error) {
    return false
  }

  try {
    deepStrictEqual(a.protocol, b.protocol)
  } catch (error) {
    return false
  }

  try {
    deepStrictEqual(a.transports, b.transports)
  } catch (error) {
    return false
  }

  try {
    deepStrictEqual(a.plugins, b.plugins)
  } catch (error) {
    return false
  }

  try {
    deepStrictEqual(a.pubsub, b.pubsub)
  } catch (error) {
    return false
  }

  try {
    deepStrictEqual(a.commands.options, b.commands.options)
  } catch (error) {
    return false
  }

  return true
}

export default async function run(
  options: Pick<
    RunWorkerOptions,
    'workerType' | 'type' | 'applicationWorkerData'
  >,
) {
  // process.on('uncaughtException', (error) => {
  //   console.error(error)
  // })

  // process.on('unhandledRejection', (error) => {
  //   console.error(error)
  // })

  let configFactory: ApplicationConfigFactory

  function resolveConfig(configFactory: ApplicationConfigFactory) {
    const config = resolveApplicationConfig(
      configFactory,
      options.type,
      options.applicationWorkerData,
    )
    for (const { job } of serverConfig.scheduler?.entries || []) {
      config.jobs.push(job)
    }
    config.plugins.push({
      plugin: JobManagerPlugin,
      options: { redisOptions: createValueInjectable(serverConfig.redis) },
    })
    return config
  }

  if (import.meta.env.DEV && import.meta.hot) {
    // notice: no need to handle #server reload here
    // as server will restart the worker on server config changes
    import.meta.hot.accept('#application', (module) => {
      if (typeof module?.default === 'function') {
        configFactory = module.default
        const newConfig = resolveConfig(configFactory)
        const oldConfig = app.config
        app.config = newConfig

        if (areConfigsEqual(oldConfig, newConfig)) {
          app.logger.info('Preforming soft reload...')
          app.reload()
        } else {
          app.logger.info('Configuration changed, performing hard restart...')
          app.stop().then(() => app.start())
        }
      }
    })
  }

  const serverConfig: ServerConfig = await import(
    // @ts-expect-error
    '#server'
  ).then((m) => m.default)

  configFactory = await import(
    // @ts-expect-error
    '#application'
  ).then((m) => m.default)

  const app = new Application(options.type, resolveConfig(configFactory))

  return new ApplicationWorker(
    options.workerType,
    app,
    options.workerType === ApplicationWorkerType.Command
      ? undefined
      : serverConfig.redis,
  )
}
