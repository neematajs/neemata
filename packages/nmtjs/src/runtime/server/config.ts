import type { TSError } from '@nmtjs/common'
import type { LoggingOptions } from '@nmtjs/core'
import type { Transport } from '@nmtjs/gateway'
import type { ApplicationOptions, PortUpstreamOptions } from '@nmtjs/proxy'
import type { Applications } from 'nmtjs/runtime/types'

import type { ApplicationConfig } from '../application/config.ts'
import type { JobWorkerPool, StoreType } from '../enums.ts'
import type { AnyJob } from '../jobs/job.ts'
import type { PubSubAdapterType } from '../pubsub/manager.ts'
import type { JobsSchedulerOptions } from '../scheduler/index.ts'
import type { StoreTypeOptions } from '../types.ts'
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
          [K in keyof Transports]: Transports[K] extends Transport<
            any,
            infer Options
          >
            ? Options
            : never
        }[]
      }
    : any

export type ServerJobsConfig = {
  pools: {
    [JobWorkerPool.Io]: ServerPoolOptions
    [JobWorkerPool.Compute]: ServerPoolOptions
  }
  jobs?: AnyJob[]
  /**
   * @deprecated Scheduler is currently being refactored and is not available.
   * Using this option will throw an error at startup.
   */
  scheduler?: JobsSchedulerOptions
  ui?: { hostname?: string; port?: number }
}

export interface ServerConfigInit {
  logger: LoggingOptions
  applications: {
    [K in keyof Applications]: Applications[K]['type'] extends 'neemata'
      ? ServerApplicationConfig<
          (Applications[K] & { type: 'neemata' })['definition']
        >
      : ServerApplicationConfig<any>
  }
  store?: ServerStoreConfig
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
    applications: {
      [K in keyof Applications]?: Omit<ApplicationOptions, 'name'>
    }
    threads?: number
    healthChecks?: { interval?: number }
    tls?: { key: string; cert: string }
  }
  jobs?: ServerJobsConfig
  commands?: {}
  pubsub?: { adapter: PubSubAdapterType }
  deploymentId?: string
}

export interface ServerConfig {
  [kServerConfig]: true
  logger: ServerConfigInit['logger']
  applications: ServerConfigInit['applications']
  store: ServerConfigInit['store']
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
  proxy: ServerConfigInit['proxy']
  jobs?: {
    pools: ServerJobsConfig['pools']
    jobs: Map<string, AnyJob>
    /**
     * @deprecated Scheduler is currently being refactored and is not available.
     * Using this option will throw an error at startup.
     */
    scheduler?: JobsSchedulerOptions
    ui?: ServerJobsConfig['ui']
  }
  commands?: {}
  pubsub: ServerConfigInit['pubsub']
  deploymentId: ServerConfigInit['deploymentId']
}

export function defineServer(options: ServerConfigInit): ServerConfig {
  const { deploymentId, logger, commands, proxy, store, applications, pubsub } =
    options

  let jobs: ServerConfig['jobs'] | undefined
  if (options.jobs) {
    const map = new Map<string, AnyJob>()
    for (const job of options.jobs.jobs ?? []) map.set(job.name, job)
    for (const { job } of options.jobs.scheduler?.entries ?? [])
      map.set(job.name, job)
    jobs = {
      pools: options.jobs.pools,
      jobs: map,
      scheduler: options.jobs.scheduler,
      ui: options.jobs.ui,
    }
  }

  return Object.freeze({
    [kServerConfig]: true,
    deploymentId,
    logger,
    commands,
    proxy,
    store,
    applications,
    pubsub,
    jobs,
  } as const)
}

export function isServerConfig(value: any): value is ServerConfig {
  return Boolean(value?.[kServerConfig])
}
