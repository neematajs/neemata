import type { HookTypes } from '@nmtjs/core'
import type { ProxyableTransportType } from '@nmtjs/gateway'
import type { Redis, RedisOptions } from 'ioredis'
import type { Redis as Valkey, RedisOptions as ValkeyOptions } from 'iovalkey'

import type { ApplicationConfig } from './application/config.ts'
import type { BaseRuntime } from './core/runtime.ts'
import type { LifecycleHook, StoreType } from './enums.ts'

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

export type ServerPortMessageTypes = {
  stop: undefined
  task: { id: string; task: WorkerJobTask }
}

export type ThreadPortMessageTypes = {
  ready: { hosts?: { type: ProxyableTransportType; url: string }[] }
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

export interface WorkerTask {
  type?: string
  payload?: any
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

export interface LifecycleHookTypes extends HookTypes {
  [LifecycleHook.BeforeInitialize]: (runtime: BaseRuntime) => any
  [LifecycleHook.AfterInitialize]: (runtime: BaseRuntime) => any
  [LifecycleHook.BeforeDispose]: (runtime: BaseRuntime) => any
  [LifecycleHook.AfterDispose]: (runtime: BaseRuntime) => any
}

export type ApplicationDefinitionType =
  | { type: 'neemata'; definition: ApplicationConfig<any, any> }
  | { type: 'custom'; definition: any }

export interface Applications
  extends Record<string, ApplicationDefinitionType> {}

export type StoreTypes = {
  [StoreType.Redis]: Redis
  [StoreType.Valkey]: Valkey
}
export type StoreTypeOptions = {
  [StoreType.Redis]: RedisOptions
  [StoreType.Valkey]: ValkeyOptions
}

export type Store = StoreTypes[StoreType]
export type StoreOptions = StoreTypeOptions[StoreType]
