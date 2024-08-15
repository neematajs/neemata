import {
  JsonTypeBuilder,
  Kind,
  type StaticDecode,
  type StaticEncode,
  type TSchema,
} from '@sinclair/typebox/type'
import { register } from './formats.ts' // register ajv formats

import { BlobType, type TBlob } from './schemas/blob.ts'
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
  SubscriptionContract,
  type TSubscriptionContract,
} from './schemas/subscription.ts'
import { type TUnionEnum, UnionEnum } from './schemas/union-enum.ts'

register()

const Contract = Object.freeze({
  Procedure: ProcedureContract,
  Event: EventContract,
  Subscription: SubscriptionContract,
  Service: ServiceContract,
})

const Type = Object.freeze(
  Object.assign(new JsonTypeBuilder(), {
    UnionEnum,
    NativeEnum,
    Nullable,
    Blob: BlobType,
  }),
)

type Encoded<T extends TSchema> = StaticEncode<T>
type Decoded<T extends TSchema> = StaticDecode<T>

export {
  Contract,
  Kind,
  Type,
  type Decoded,
  type Encoded,
  type TBlob,
  type TEventContract,
  type TProcedureContract,
  type TBaseProcedureContract,
  type TSchema,
  type TServiceContract,
  type TSubscriptionContract,
  type TUnionEnum,
  type TNativeEnum,
}
