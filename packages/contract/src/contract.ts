import './formats' // register ajv formats

import {
  JsonTypeBuilder,
  Kind,
  type StaticDecode,
  type StaticEncode,
  type TSchema,
} from '@sinclair/typebox/type'

import { EventContract, type TEventContract } from './schemas/event.ts'
import { NativeEnum, type TNativeEnum } from './schemas/native-enum.ts'
import { Nullable } from './schemas/nullable.ts'
import {
  ProcedureContract,
  type TBaseProcedureContract,
  type TProcedureContract,
} from './schemas/procedure.ts'
import { ServiceContract, type TServiceContract } from './schemas/service.ts'
import {
  type DownStream,
  DownStreamContract,
  type TDownStreamContract,
  type TUpStreamContract,
  type UpStream,
  UpStreamContract,
} from './schemas/streams.ts'
import {
  SubscriptionContract,
  type TSubscriptionContract,
} from './schemas/subscription.ts'
import { type TUnionEnum, UnionEnum } from './schemas/union-enum.ts'

const Contract = Object.freeze({
  Procedure: ProcedureContract,
  Event: EventContract,
  Subscription: SubscriptionContract,
  Service: ServiceContract,
  UpStream: UpStreamContract,
  DownStream: DownStreamContract,
})

const Type = Object.freeze(
  Object.assign(new JsonTypeBuilder(), { UnionEnum, NativeEnum, Nullable }),
)

type Encoded<T extends TSchema> = StaticEncode<T>
type Decoded<T extends TSchema> = StaticDecode<T>

export {
  Contract,
  Kind,
  Type,
  type Decoded,
  type DownStream,
  type Encoded,
  type TDownStreamContract,
  type TEventContract,
  type TProcedureContract,
  type TBaseProcedureContract,
  type TSchema,
  type TServiceContract,
  type TSubscriptionContract,
  type TUnionEnum,
  type TUpStreamContract,
  type UpStream,
  type TNativeEnum,
}
