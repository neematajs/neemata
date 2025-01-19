import { Kind } from '../constants.ts'
import {
  type ContractSchemaOptions,
  applyNames,
  createSchema,
} from '../utils.ts'
import type { TEventContract } from './event.ts'
import type { TBaseProcedureContract, TProcedureContract } from './procedure.ts'
import type { TSubscriptionContract } from './subscription.ts'

export const ServiceKind = 'NeemataService'
export interface TServiceContract<
  Name extends string = string,
  Transports extends { [K in string]?: true } = { [K in string]?: true },
  Procedures extends Record<string, TBaseProcedureContract> = Record<
    string,
    TBaseProcedureContract
  >,
  Events extends Record<string, TEventContract> = Record<
    string,
    TEventContract
  >,
> {
  [Kind]: typeof ServiceKind
  type: 'neemata:service'
  name: Name
  transports: Transports
  procedures: {
    [K in keyof Procedures]: Procedures[K] extends TProcedureContract<
      infer Input,
      infer Output,
      any,
      any,
      any
    >
      ? // ? true
        TProcedureContract<Input, Output, Extract<K, string>, Name, Transports>
      : Procedures[K] extends TSubscriptionContract<
            infer Input,
            infer Output,
            infer Options,
            infer Events,
            any,
            any,
            any
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
        : Procedures[K]
  }
  events: {
    [K in Extract<keyof Events, string>]: Events[K] extends TEventContract<
      infer Payload
    >
      ? TEventContract<Payload, K, Name>
      : Events[K]
  }
  timeout?: number
}

export const ServiceContract = <
  Name extends string,
  Transports extends { [key: string]: true },
  Procedures extends Record<
    string,
    TBaseProcedureContract | TProcedureContract | TSubscriptionContract
  >,
  Events extends Record<string, TEventContract>,
>(
  name: Name,
  transports: Transports,
  procedures: Procedures = {} as Procedures,
  events: Events = {} as Events,
  timeout?: number,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) => {
  const serviceProcedures = {}

  for (const [procedureName, procedure] of Object.entries(procedures)) {
    if (procedure.type === 'neemata:subscription') {
      serviceProcedures[procedureName] = {
        ...procedure,
        events: applyNames((procedure as TSubscriptionContract).events, {
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
    procedures: applyNames(serviceProcedures, { serviceName: name }) as any,
    events: applyNames(events, { serviceName: name }) as any,
    transports,
    timeout,
  })
}

export function IsServiceContract(value: any): value is TServiceContract {
  return Kind in value && value[Kind] === ServiceKind
}
