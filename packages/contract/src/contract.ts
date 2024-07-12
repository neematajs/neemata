import { TransportType } from '@neematajs/common'
import { JsonTypeBuilder, Kind } from '@sinclair/typebox/type'
import { EventContract, type TEventContract } from './schemas/event'
import { ProcedureContract, type TProcedureContract } from './schemas/procedure'
import { ServiceContract, type TServiceContract } from './schemas/service'
import {
  SubscriptionContract,
  type TSubscriptionContract,
} from './schemas/subscription'
import { type TUnionEnum, UnionEnum } from './schemas/union'

import './formats' // register ajv formats

const Contract = Object.freeze(
  Object.assign(new JsonTypeBuilder(), {
    Procedure: ProcedureContract,
    Event: EventContract,
    Subscription: SubscriptionContract,
    Service: ServiceContract,
    Union: UnionEnum,
  }),
)

export {
  Contract,
  Kind,
  type TUnionEnum,
  type TEventContract,
  type TProcedureContract,
  type TServiceContract,
  type TSubscriptionContract,
}
