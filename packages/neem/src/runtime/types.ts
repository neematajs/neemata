import type { LoggingOptions } from '@nmtjs/core'
import type { ApplicationOptions } from '@nmtjs/proxy'

import type { NeemCommandsConfig } from './commands.ts'
import type { NeemServerPlugin } from './plugins.ts'

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

export type WorkerJobTask = { jobId: string; jobName: string; data: any }

export type JobTaskResult = {
  [K in keyof JobTaskResultTypes]: { type: K } & JobTaskResultTypes[K]
}[keyof JobTaskResultTypes]

export type JobTaskResultTypes = {
  success: { result?: unknown }
  error: { error: any }
  unrecoverable_error: { error: any }
  job_not_found: {}
  queue_job_not_found: {}
}

export type ServerPortMessageTypes = {
  stop: undefined
  task: { id: string; task: WorkerJobTask }
}

export type ThreadPortMessageTypes = {
  ready: { hosts?: ApplicationUpstream[] }
  error: ThreadErrorMessage
  task: { id: string; task: JobTaskResult }
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
  commands?: NeemCommandsConfig
  plugins?: NeemServerPlugin[]
  deploymentId?: string
  metrics?: { path?: string; port?: number; host?: string }
}
