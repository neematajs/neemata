import { EventContract, type TEventContract } from './schemas/event.ts'

import {
  ProcedureContract,
  type TBaseProcedureContract,
  type TProcedureContract,
} from './schemas/procedure.ts'
import { ServiceContract, type TServiceContract } from './schemas/service.ts'
import {
  type SubcriptionOptions,
  SubscriptionContract,
  type TSubscriptionContract,
} from './schemas/subscription.ts'
import { blob as blobType } from './types/blob.ts'

export type {
  TEventContract,
  TProcedureContract,
  TBaseProcedureContract,
  TServiceContract,
  TSubscriptionContract,
  SubcriptionOptions,
}

export namespace c {
  export const procedure = ProcedureContract
  export const event = EventContract
  export const subscription = SubscriptionContract
  export const service = ServiceContract
  export const blob = blobType
}
