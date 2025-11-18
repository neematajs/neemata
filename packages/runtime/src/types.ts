import type { LifecycleHook } from './enums.ts'
import type { ApplicationWorkerRuntime } from './workers/index.ts'

export type ServerPortMessage =
  | { type: 'ready'; data?: never }
  | { type: 'task'; data: { id: string; data: JobTaskResult } }

export type ThreadPortMessage =
  | { type: 'stop' }
  | { type: 'task'; data: { id: string; data: WorkerJobTask } }

export interface WorkerTask {
  type?: string
  data?: any
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

export interface LifecycleHookTypes
  extends Record<LifecycleHook, (...args: any[]) => unknown> {
  // [LifecycleHook.RuntimeInitializeBefore]: (
  //   worker: ApplicationWorkerRuntime,
  //   app: Application,
  // ) => any
  // [LifecycleHook.InitializeAfter]: (app: Application) => any
  // [LifecycleHook.StartBefore]: (app: Application) => any
  // [LifecycleHook.StartAfter]: (app: Application) => any
  // [LifecycleHook.StopBefore]: (app: Application) => any
  // [LifecycleHook.StopAfter]: (app: Application) => any
  // [LifecycleHook.DisposeBefore]: (app: Application) => any
  // [LifecycleHook.DisposeAfter]: (app: Application) => any
  // [LifecycleHook.PluginInitializeBefore]: (
  //   plugin: ApplicationPlugin,
  //   app: Application,
  // ) => any
  // [LifecycleHook.PluginInitializeAfter]: (
  //   plugin: ApplicationPlugin,
  //   instance: ApplicationPluginType,
  //   app: Application,
  // ) => any
  // [LifecycleHook.PluginDisposeBefore]: (
  //   plugin: ApplicationPlugin,
  //   instance: ApplicationPluginType,
  //   app: Application,
  // ) => any
  // [LifecycleHook.PluginDisposeAfter]: (
  //   plugin: ApplicationPlugin,
  //   instance: ApplicationPluginType,
  //   app: Application,
  // ) => any
  // [LifecycleHook.TransportInitializeBefore]: (
  //   transport: TransportPlugin,
  //   app: Application,
  // ) => any
  // [LifecycleHook.TransportInitializeAfter]: (
  //   transport: TransportPlugin,
  //   instance: Transport,
  //   app: Application,
  // ) => any
  // [LifecycleHook.ContainerInitializeBefore]: (
  //   container: Container,
  //   app: Application,
  // ) => any
  // [LifecycleHook.ContainerInitializeAfter]: (
  //   container: Container,
  //   app: Application,
  // ) => any
  // [LifecycleHook.ContainerDisposeBefore]: (
  //   container: Container,
  //   app: Application,
  // ) => any
  // [LifecycleHook.ContainerDisposeAfter]: (
  //   container: Container,
  //   app: Application,
  // ) => any
}

// biome-ignore lint/suspicious/noEmptyInterface: its externally extended
export interface Applications {}
