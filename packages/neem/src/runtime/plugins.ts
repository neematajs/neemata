import type { MessagePort, WorkerOptions } from 'node:worker_threads'

import type { NestedHooks } from 'hookable'
import type { UserConfig } from 'vite'
import { Hookable } from 'hookable'

import type { WorkerType } from './enums.ts'
import type { WorkerState } from './managed-worker.ts'

export type PluginBuildEntrypoint = {
  id: string
  source: string
  target: 'worker' | 'server' | 'cli'
  vite?: UserConfig
}

export interface NeemBuildContext {
  mode: 'production'
}

export type NeemPluginBuildEntrypointsResolver = (
  ctx: NeemBuildContext,
) => PluginBuildEntrypoint[] | Promise<PluginBuildEntrypoint[]>

export interface NeemPluginWorkerSpawnOptions {
  id?: string
  name: string
  path?: string
  type?: WorkerType
  workerData?: Record<string, unknown>
  ports?: Record<string, MessagePort>
  workerOptions?: Partial<WorkerOptions>
}

export interface NeemServerPluginWorkerHandle {
  readonly id: string
  readonly name: string
  readonly type: WorkerType
  readonly path: string
  getState: () => WorkerState
  isHealthy: () => boolean
  stop: () => Promise<void>
}

export interface NeemServerPluginWorkerSnapshot {
  id: string
  name: string
  type: WorkerType
  path: string
  state: WorkerState
  healthy: boolean
}

export interface NeemServerPluginWorkers {
  spawn: (
    options: NeemPluginWorkerSpawnOptions,
  ) => Promise<NeemServerPluginWorkerHandle>
  stop: (workerId: string) => Promise<boolean>
  get: (workerId: string) => NeemServerPluginWorkerHandle | undefined
  list: () => NeemServerPluginWorkerSnapshot[]
  stopAll: () => Promise<void>
}

export interface NeemServerPluginContext {
  mode: 'development' | 'production'
  instanceId: number
  poolName: string
  workers: NeemServerPluginWorkers
}

export interface NeemServerPluginHookTypes {
  'server:setup': (ctx: NeemServerPluginContext) => Promise<void> | void
  'server:start': (ctx: NeemServerPluginContext) => Promise<void> | void
  'server:stop': (ctx: NeemServerPluginContext) => Promise<void> | void
  'server:dispose': (ctx: NeemServerPluginContext) => Promise<void> | void
}

export class NeemServerPluginHooks extends Hookable<NeemServerPluginHookTypes> {
  _!: { config: NestedHooks<NeemServerPluginHookTypes> }
}

export interface NeemServerPlugin {
  name: string
  build?: { entrypoints?: NeemPluginBuildEntrypointsResolver }
  hooks?: NeemServerPluginHooks['_']['config']
}

export function createPlugin<T extends NeemServerPlugin>(plugin: T): T {
  return plugin
}
