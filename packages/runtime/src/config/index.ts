import type { LoggingOptions } from '@nmtjs/core'
import type { TransportV2 } from '@nmtjs/gateway'
import type { Applications } from '@nmtjs/runtime/types'
import type { RedisOptions } from 'ioredis'

import type { JobWorkerQueue } from '../enums.ts'
import type { Job } from '../jobs/job.ts'
import type { JobsSchedulerOptions } from '../scheduler/index.ts'
import { kServerConfig } from '../constants.ts'

export type ServerPoolOptions = {
  /**
   * Number of worker threads
   */
  threads: number
  /**
   * Number of jobs per worker
   */
  jobs: number
}

export interface ServerConfig {
  [kServerConfig]: any
  logger: LoggingOptions
  applications: {
    [K in keyof Applications]: {
      threads: number | any[]
      transports: { [transportKey: string]: TransportV2 }
    }
  }
  jobs: {
    jobs: Job[]
    queues: {
      [JobWorkerQueue.Io]: ServerPoolOptions
      [JobWorkerQueue.Compute]: ServerPoolOptions
    }
  }
  deploymentId?: string
  scheduler?: JobsSchedulerOptions
  redis?: RedisOptions
}

export function defineServer(options: Partial<ServerConfig>): ServerConfig {
  const {
    deploymentId,
    logger = {},
    scheduler,
    redis,
    applications = {},
    jobs = {
      jobs: [],
      queues: { Io: { threads: 0, jobs: 0 }, Compute: { threads: 0, jobs: 0 } },
    },
  } = options
  return Object.freeze({
    [kServerConfig]: true,
    deploymentId,
    logger,
    scheduler,
    redis,
    applications,
    jobs,
  } as const)
}

export function isServerConfig(value: any): value is ServerConfig {
  return Boolean(value?.[kServerConfig])
}
