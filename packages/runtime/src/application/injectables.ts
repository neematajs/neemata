import { createLazyInjectable, Scope } from '@nmtjs/core'

import type { Commands } from './commands.ts'
import type { ApplicationType } from './enums.ts'
import type { JobRunner } from './job-runner.ts'
import type { PubSub, PubSubAdapter } from './pubsub.ts'

const appShutdownSignal = createLazyInjectable<AbortSignal>(
  Scope.Global,
  'Application shutdown signal',
)
const pubsub = createLazyInjectable<PubSub>(Scope.Global, 'Pubsub')
const pubsubAdapter = createLazyInjectable<PubSubAdapter>(
  Scope.Global,
  'Pubsub adapter',
)
const executeCommand = createLazyInjectable<Commands['execute']>(
  Scope.Global,
  'Execute application command',
)
const runJob = createLazyInjectable<JobRunner['runJob']>(
  Scope.Global,
  'Run job',
)
const workerType = createLazyInjectable<ApplicationType>(
  Scope.Global,
  'Application worker type',
)
export const AppInjectables = {
  appShutdownSignal,
  workerType,
  executeCommand,
  runJob,
  pubsub,
  pubsubAdapter,
}
