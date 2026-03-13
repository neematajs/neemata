import type EventEmitter from 'node:events'
import type { Worker } from 'node:worker_threads'

import type { LoggingOptions } from '@nmtjs/core'
import type { ApplicationOptions } from '@nmtjs/proxy'
import type { UserConfig, ViteDevServer } from 'vite'

import type { NeemCommandsConfig } from './runtime/commands.ts'
import type { NeemServerPlugin } from './runtime/plugins.ts'

/**
 * Run options for the Neem application server.
 */
export type NeemServerRunOptions = { applications: string[] }

export type NeemPoolId = string

export type NeemPoolKind = 'application' | 'plugin'

export interface NeemPoolViteConfig {
  config?: UserConfig
  entrypoints?: string[]
}

export interface NeemPoolDescriptor {
  id: NeemPoolId
  kind: NeemPoolKind
  owner: string
  vite: NeemPoolViteConfig
}

export interface NeemPoolEnvironmentHandle {
  poolId: NeemPoolId
  server: ViteDevServer
  environmentName: string
  stop: () => Promise<void>
}

export interface NeemPoolHmrUpdate {
  poolId: NeemPoolId
  environmentName: string
  file: string
}

export interface NeemPoolEnvironmentOrchestrator {
  ensurePoolEnvironment: (
    descriptor: NeemPoolDescriptor,
  ) => Promise<NeemPoolEnvironmentHandle>
  getPoolEnvironment: (
    poolId: NeemPoolId,
  ) => NeemPoolEnvironmentHandle | undefined
  attachWorker: (poolId: NeemPoolId, worker: Worker) => void
  detachWorker: (poolId: NeemPoolId, threadId: number) => void
  stopPoolEnvironment: (poolId: NeemPoolId) => Promise<void>
  stopAll: () => Promise<void>
}

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
  onWorker?: (worker: Worker) => any
  events?: EventEmitter<WorkerEventMap>
}

export type ApplicationUpstream = { type: 'http' | 'http2' | 'ws'; url: string }

export type WorkerThreadErrorOrigin = 'bootstrap' | 'start' | 'runtime'

export type ThreadErrorMessage = {
  message: string
  name?: string
  stack?: string
  origin: WorkerThreadErrorOrigin
  fatal: boolean
}

export type WorkerThreadError = Error & {
  origin?: WorkerThreadErrorOrigin
  fatal?: boolean
}

export type ServerPortMessageTypes = { stop: undefined }

export type ThreadPortMessageTypes = {
  ready: { hosts?: ApplicationUpstream[] }
  error: ThreadErrorMessage
}

export type ServerPortMessage = {
  [K in keyof ServerPortMessageTypes]: {
    type: K
    data: ServerPortMessageTypes[K]
  }
}[keyof ServerPortMessageTypes]

export type ThreadPortMessage = {
  [K in keyof ThreadPortMessageTypes]: {
    type: K
    data: ThreadPortMessageTypes[K]
  }
}[keyof ThreadPortMessageTypes]

export interface ApplicationRuntime {
  start: () => Promise<ApplicationUpstream[] | undefined>
  stop: () => Promise<void>
  reload?: (definition: unknown) => Promise<void>
}

export interface ApplicationAdapter<
  AdapterId extends string = string,
  Definition = unknown,
  ThreadOptions = unknown,
> {
  id: AdapterId
  createRuntime: (options: {
    applicationName: string
    definition: Definition
    mode: 'development' | 'production'
    threadOptions: ThreadOptions
  }) => Promise<ApplicationRuntime> | ApplicationRuntime
}

export interface ApplicationDefinition<
  TAdapter extends ApplicationAdapter = ApplicationAdapter,
> {
  adapter: TAdapter
  commands?: NeemCommandsConfig
  definition: TAdapter extends ApplicationAdapter<
    string,
    infer TDefinition,
    any
  >
    ? TDefinition
    : never
}

export type AnyApplicationDefinition = ApplicationDefinition<ApplicationAdapter>

export interface Applications
  extends Record<string, AnyApplicationDefinition> {}

export type InferApplicationAdapter<TApplication> =
  TApplication extends ApplicationDefinition<infer TAdapter>
    ? TAdapter
    : ApplicationAdapter

export type InferApplicationThreadOptions<TApplication> =
  InferApplicationAdapter<TApplication> extends ApplicationAdapter<
    string,
    any,
    infer TThreadOptions
  >
    ? TThreadOptions
    : unknown

export type NeemServerApplicationsConfig<TApps extends Applications> = {
  [K in keyof TApps]: {
    threads: Array<InferApplicationThreadOptions<TApps[K]>>
  }
}

export interface NeemServerProxyConfig<TApps extends Applications> {
  port: number
  hostname: string
  applications: {
    [K in keyof TApps]?: Omit<ApplicationOptions, 'name'>
  }
  threads?: number
  healthChecks?: { interval?: number }
  tls?: { key: string; cert: string }
}

export interface NeemServerConfigInit<
  TApps extends Applications = Applications,
> {
  logger?: LoggingOptions
  applications: NeemServerApplicationsConfig<TApps>
  proxy?: NeemServerProxyConfig<TApps>
  plugins?: NeemServerPlugin[]
  deploymentId?: string
  metrics?: { path?: string; port?: number; host?: string }
}
