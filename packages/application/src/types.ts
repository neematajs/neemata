import type { AnyRouter, Api } from '@nmtjs/api'
import type { Container, Hooks, Logger } from '@nmtjs/core'
import type { Protocol, ProtocolFormat } from '@nmtjs/protocol/server'

import type { Application } from './application.ts'
import type { WorkerType } from './enums.ts'
import type { ApplicationRegistry } from './registry.ts'
import type { AnyTask, BaseTaskExecutor, Task, TaskExecution } from './tasks.ts'

export type Command = (options: {
  args: string[]
  kwargs: Record<string, any>
}) => any

export interface ApplicationPluginContext {
  readonly type: WorkerType
  readonly api: Api
  readonly format: ProtocolFormat
  readonly container: Container
  readonly logger: Logger
  readonly registry: ApplicationRegistry
  readonly hooks: Hooks
  readonly protocol: Protocol
}

export type ExecuteFn = <
  T extends AnyTask,
  A extends T extends Task<any, any, infer Args> ? Args : never,
  R extends T extends Task<any, any, any, infer Result> ? Result : never,
>(
  task: T,
  ...args: A
) => TaskExecution<R>

export type ApplicationWorkerOptions = {
  isServer: boolean
  workerType: WorkerType
  id: number
  workerOptions: any
  tasksRunner?: BaseTaskExecutor
}

export type ExtractApplicationAPIContract<T extends Application> =
  T extends Application<infer Router extends AnyRouter>
    ? Router['contract']
    : never
