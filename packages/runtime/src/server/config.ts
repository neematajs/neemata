import type { TSError } from '@nmtjs/common'
import type { LoggingOptions } from '@nmtjs/core'
import type { TransportV2 } from '@nmtjs/gateway'
import type { Applications, StoreTypeOptions } from '@nmtjs/runtime/types'

import type { ApplicationConfig } from '../application/config.ts'
import type { JobWorkerQueue, StoreType } from '../enums.ts'
import type { Job } from '../jobs/job.ts'
import type { PubSubAdapterType } from '../pubsub/index.ts'
import type { JobsSchedulerOptions } from '../scheduler/index.ts'
import { kServerConfig } from '../constants.ts'

export type ServerPoolOptions = {
  /**
   * Number of worker threads
   */
  threads: number
  /**
   * Max number of jobs per worker
   */
  jobs: number
}

export type ServerStoreConfig =
  | { type: StoreType.Redis; options: StoreTypeOptions[StoreType.Redis] }
  | { type: StoreType.Valkey; options: StoreTypeOptions[StoreType.Valkey] }

export type ServerApplicationConfig<T = ApplicationConfig> =
  T extends ApplicationConfig<any, infer Transports>
    ? {
        threads: {
          [K in keyof Transports]: Transports[K] extends TransportV2<
            any,
            infer Options
          >
            ? Options
            : never
        }[]
      }
    : TSError<'Invalid application path'>

export interface ServerConfig {
  [kServerConfig]: any
  logger: LoggingOptions
  applications: {
    [K in keyof Applications]: ServerApplicationConfig<Applications[K]>
  }
  store: ServerStoreConfig
  /**
   * Proxy configuration. Enabling this will start a reverse proxy server that handles TLS, routing,
   * load balancing, and health checks for your applications.
   *
   * The applications will be accessible via `<hostname>:<port>/<application-name>/**`
   *
   * Requires adding `@nmtjs/proxy` package to your dependencies
   * and [`cargo`](https://doc.rust-lang.org/cargo/getting-started/installation.html) alongside with
   * [`rustc`](https://www.rust-lang.org/tools/install) to be available globally for building native modules.
   */
  proxy?: {
    port: number
    hostname: string
    threads?: number
    healthChecks?: { interval?: number }
    tls?: { key: string; cert: string }
  }
  jobs?: {
    jobs: Job[]
    queues: {
      [JobWorkerQueue.Io]: ServerPoolOptions
      [JobWorkerQueue.Compute]: ServerPoolOptions
    }
    scheduler?: JobsSchedulerOptions
  }
  commands?: {}
  pubsub?: { adapter: PubSubAdapterType }
  deploymentId?: string
}

export function defineServer(
  options: Omit<ServerConfig, kServerConfig> &
    Partial<Omit<ServerConfig, 'applications' | 'store' | 'logger'>>,
): ServerConfig {
  const {
    deploymentId,
    logger,
    commands,
    proxy,
    store,
    applications,
    jobs = {
      jobs: [],
      queues: { Io: { threads: 0, jobs: 0 }, Compute: { threads: 0, jobs: 0 } },
    },
  } = options
  return Object.freeze({
    [kServerConfig]: true,
    deploymentId,
    logger,
    commands,
    proxy,
    store,
    applications,
    jobs,
  } as const)
}

export function isServerConfig(value: any): value is ServerConfig {
  return Boolean(value?.[kServerConfig])
}
