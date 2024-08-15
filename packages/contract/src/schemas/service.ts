import { Kind, type TSchema, TypeRegistry } from '@sinclair/typebox/type'
import {
  type ContractSchemaOptions,
  applyNames,
  createSchema,
} from '../utils.ts'
import type { TEventContract } from './event.ts'
import type { TProcedureContract } from './procedure.ts'
import { SubscriptionKind, type TSubscriptionContract } from './subscription.ts'

export const ServiceKind = 'NeemataService'

export interface TServiceContract<
  Name extends string = string,
  Transports extends { [K in string]?: true } = {},
  Procedures extends Record<
    string,
    TProcedureContract | TSubscriptionContract
  > = Record<string, TProcedureContract | TSubscriptionContract>,
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
    subscriptions: {
      [K in keyof Procedures]: Procedures[K]['static']
    }
    events: {
      [K in keyof Events]: Events[K]['static']
    }
    transports: Transports
  }
  type: 'neemata:service'
  name: Name
  transports: Transports
  procedures: {
    [K in keyof Procedures]: Procedures[K] extends TProcedureContract<
      infer Input,
      infer Output
    >
      ? TProcedureContract<Input, Output, Extract<K, string>, Name, Transports>
      : Procedures[K] extends TSubscriptionContract<
            infer Input,
            infer Output,
            infer Options,
            infer Events
          >
        ? TSubscriptionContract<
            Input,
            Output,
            Options,
            {
              [EK in keyof Events]: Events[EK] extends TEventContract<
                infer Payload
              >
                ? TEventContract<
                    Payload,
                    Extract<EK, string>,
                    Name,
                    Extract<K, string>
                  >
                : never
            },
            Extract<K, string>,
            Name,
            Transports
          >
        : never
  }
  events: {
    [K in Extract<keyof Events, string>]: Events[K] extends TEventContract<
      infer Payload
    >
      ? TEventContract<Payload, K, Name>
      : never
  }
  timeout?: number
}

export const ServiceContract = <
  Name extends string,
  Transports extends { [key: string]: true },
  Procedures extends Record<string, TProcedureContract | TSubscriptionContract>,
  Events extends Record<string, TEventContract>,
>(
  name: Name,
  transports: Transports,
  procedures: Procedures = {} as Procedures,
  events: Events = {} as Events,
  timeout?: number,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) => {
  if (!TypeRegistry.Has(ServiceKind)) TypeRegistry.Set(ServiceKind, () => true)

  const serviceProcedures = {}

  for (const [procedureName, procedure] of Object.entries(procedures)) {
    if (procedure[Kind] === SubscriptionKind) {
      serviceProcedures[procedureName] = {
        ...procedure,
        events: applyNames(procedure.events, {
          serviceName: name,
          subscriptionName: procedureName,
        }),
      }
    } else {
      serviceProcedures[procedureName] = procedure
    }
  }

  return createSchema<TServiceContract<Name, Transports, Procedures, Events>>({
    ...schemaOptions,
    [Kind]: ServiceKind,
    name: name,
    type: 'neemata:service',
    procedures: applyNames(procedures, { serviceName: name }),
    events: applyNames(events, { serviceName: name }),
    transports,
    timeout,
  })
}
