import type { HookTypes } from '@nmtjs/core'
import type { Redis, RedisOptions } from 'ioredis'
import type { Redis as Valkey, RedisOptions as ValkeyOptions } from 'iovalkey'

import type { ApplicationConfig } from './application/config.ts'
import type { BaseRuntime } from './core/runtime.ts'
import type { LifecycleHook, StoreType } from './enums.ts'

export type ServerPortMessageTypes = {
  stop: undefined
  task: { id: string; task: WorkerJobTask }
}

export type ThreadPortMessageTypes = {
  ready: { hosts: string[] }
  error: { error: Error }
  task: { id: string; task: WorkerJobTask }
}

export type ServerPortMessage = {
  [K in keyof ServerPortMessageTypes]: { type: K } & ServerPortMessageTypes[K]
}[keyof ServerPortMessageTypes]

export type ThreadPortMessage = {
  [K in keyof ThreadPortMessageTypes]: { type: K } & ThreadPortMessageTypes[K]
}[keyof ThreadPortMessageTypes]

export interface WorkerTask {
  type?: string
  payload?: any
}

export type WorkerJobTask = { jobId: string; jobName: string }

export type JobTaskResult = {
  [K in keyof JobTaskResultTypes]: { type: K } & JobTaskResultTypes[K]
}[keyof JobTaskResultTypes]

export type JobTaskResultTypes = {
  success: { result?: unknown }
  error: { error: Error }
  job_not_found: {}
  queue_job_not_found: {}
}

export interface LifecycleHookTypes extends HookTypes {
  [LifecycleHook.BeforeInitialize]: (runtime: BaseRuntime) => any
  [LifecycleHook.AfterInitialize]: (runtime: BaseRuntime) => any
  [LifecycleHook.BeforeDispose]: (runtime: BaseRuntime) => any
  [LifecycleHook.AfterDispose]: (runtime: BaseRuntime) => any
}

export interface Applications
  extends Record<string, ApplicationConfig<any, any>> {}

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
