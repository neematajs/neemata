import {
  EventContract,
  IsEventContract,
  type TEventContract,
} from './schemas/event.ts'
import {
  IsProcedureContract,
  ProcedureContract,
  type TBaseProcedureContract,
  type TProcedureContract,
} from './schemas/procedure.ts'
import {
  IsServiceContract,
  ServiceContract,
  type TServiceContract,
} from './schemas/service.ts'
import {
  IsSubscriptionContract,
  type SubcriptionOptions,
  SubscriptionContract,
  type TSubscriptionContract,
} from './schemas/subscription.ts'
import { blob as blobType } from './types/blob.ts'

export {
  type TEventContract,
  type TProcedureContract,
  type TBaseProcedureContract,
  type TServiceContract,
  type TSubscriptionContract,
  type SubcriptionOptions,
  IsEventContract,
  IsProcedureContract,
  IsServiceContract,
  IsSubscriptionContract,
}

export namespace c {
  export const procedure = ProcedureContract
  export const event = EventContract
  export const subscription = SubscriptionContract
  export const service = ServiceContract
  export const blob = blobType
}
