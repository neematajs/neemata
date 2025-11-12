import type { LoggingOptions } from '@nmtjs/core'
import type { RedisOptions } from 'ioredis'
import { ApplicationWorkerType } from '@nmtjs/application'

import type { JobsSchedulerOptions } from './scheduler.ts'
import { kServerConfig } from './constants.ts'

// export type ServerPoolType = 'io' | 'compute'
export type ServerPoolOptions = { threadsNumber: number; jobsPerWorker: number }

export interface ServerConfig {
  [kServerConfig]: any
  logger: LoggingOptions
  applications: {}
  jobs: []
  workers: {
    /**
     * Number of API workers or an array of specific configurations for each worker,
     * that will be passed to the defineApplication callback,
     * which can be useful, for example, for passing exact ports for API transport to listen to
     */
    [ApplicationWorkerType.Api]: number | any[]
    [ApplicationWorkerType.Io]: ServerPoolOptions
    [ApplicationWorkerType.Compute]: ServerPoolOptions
  }
  deploymentId?: string
  scheduler?: JobsSchedulerOptions
  redis?: RedisOptions
}

export function defineServer(
  options: Partial<ServerConfig> & {
    workers?: Partial<ServerConfig['workers']>
  },
): ServerConfig {
  const {
    deploymentId,
    logger = {},
    scheduler,
    redis,
    workers = {
      [ApplicationWorkerType.Api]: 1,
      [ApplicationWorkerType.Io]: { threadsNumber: 1, jobsPerWorker: 100 },
      [ApplicationWorkerType.Compute]: { threadsNumber: 1, jobsPerWorker: 1 },
    },
  } = options
  return Object.freeze({
    [kServerConfig]: true,
    deploymentId,
    logger,
    scheduler,
    redis,
    workers,
  } as const)
}

export function isServerConfig(value: any): value is ServerConfig {
  return Boolean(value?.[kServerConfig])
}
