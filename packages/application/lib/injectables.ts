import { createLazyInjectable, Scope } from '@nmtjs/core'
import type { WorkerType } from './enums.ts'
import type { ExecuteFn } from './types.ts'

const appShutdownSignal = createLazyInjectable<AbortSignal>(
  Scope.Global,
  'Application shutdown signal',
)
const taskAbortSignal = createLazyInjectable<AbortSignal>(
  Scope.Global,
  'Task abort signal',
)
const execute = createLazyInjectable<ExecuteFn>(Scope.Global, 'Task executor')
const workerType = createLazyInjectable<WorkerType>(
  Scope.Global,
  'Application worker type',
)

export const AppInjectables = {
  appShutdownSignal,
  taskAbortSignal,
  workerType,
  execute,
}
