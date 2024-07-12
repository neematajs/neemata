import type { TransportType } from '@neematajs/common'
import { Kind, type TSchema } from '@sinclair/typebox/type'
import { type NeemataContractSchemaOptions, createSchema } from '../utils'
import type { TEventContract } from './event'
import type { TProcedureContract } from './procedure'
import type { TSubscriptionContract } from './subscription'

export const ServiceKind = 'NeemataService'

export interface TServiceContract<
  Name extends string = string,
  Transports extends { [K in string]?: true } = {},
  Procedures extends Record<string, TProcedureContract> = Record<
    string,
    TProcedureContract
  >,
  // Subscriptions extends Record<string, TSubscriptionContract> = Record<
  //   string,
  //   TSubscriptionContract
  // >,
  Events extends Record<string, TEventContract> = Record<
    string,
    TEventContract
  >,
> extends TSchema {
  [Kind]: typeof ServiceKind
  static: {
    procedures: {
      [K in keyof Procedures]: Procedures[K]['static']
    }
    // subscriptions: {
    //   [K in keyof Subscriptions]: Subscriptions[K]['static']
    // }
    events: {
      [K in keyof Events]: Events[K]['static']
    }
    transports: Transports
  }
  type: 'neemata:service'
  name: Name
  transports: Transports
  procedures: Procedures
  // subscriptions: Subscriptions
  events: Events
  timeout?: number
}

export const ServiceContract = <
  Name extends string,
  Transports extends { [key: string]: true },
  Procedures extends Record<string, TProcedureContract<any>>,
  // Subscriptions extends Record<string, TSubscriptionContract<any>>,
  Events extends Record<string, TEventContract>,
  SOptions extends NeemataContractSchemaOptions,
>(
  name: Name,
  transports: Transports,
  procedures: Procedures = {} as Procedures,
  // subscriptions: Subscriptions = {} as Subscriptions,
  events: Events = {} as Events,
  timeout?: number,
  schemaOptions: SOptions = {} as SOptions,
) =>
  createSchema<
    TServiceContract<
      Name,
      Transports,
      Procedures,
      // Subscriptions,
      Events
    >
  >({
    ...schemaOptions,
    [Kind]: ServiceKind,
    name: name,
    type: 'neemata:service',
    procedures,
    // subscriptions,
    events,
    transports,
    timeout,
  })
