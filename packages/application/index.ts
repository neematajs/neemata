import {
  createFactoryInjectable,
  createLazyInjectable,
  createValueInjectable,
} from './lib/container.ts'
import { createContractProcedure, createProcedure } from './lib/procedure.ts'
import { createContractService } from './lib/service.ts'

export * from './lib/api.ts'
export * from './lib/application.ts'
export * from './lib/constants.ts'
export * from './lib/container.ts'
export * from './lib/events.ts'
export * from './lib/plugin.ts'
export * from './lib/format.ts'
export * from './lib/service.ts'
export * from './lib/format.ts'
export * from './lib/logger.ts'
export * from './lib/registry.ts'
export * from './lib/stream.ts'
export * from './lib/subscription.ts'
export * from './lib/task.ts'
export * from './lib/connection.ts'
export * from './lib/types.ts'
export * from './lib/common.ts'
export * from './lib/utils/functions.ts'
export * from './lib/utils/pool.ts'
export * from './lib/utils/semaphore.ts'

export namespace n {
  export const value = createValueInjectable
  export const lazy = createLazyInjectable
  export const factory = createFactoryInjectable
  export const procedure = createContractProcedure
  export const service = createContractService
  export const contractless = {
    procedure: createProcedure,
    service: createContractService,
  }
}
