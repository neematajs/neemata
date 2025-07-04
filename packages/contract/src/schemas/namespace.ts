import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'
import type { TAnyProcedureContract, TProcedureContract } from './procedure.ts'

export const NamespaceKind = 'NeemataNamespace'

export type TAnyNamespaceContract = TNamespaceContract<
  Record<string, any>,
  Record<string, any>,
  string | undefined
>

export interface TNamespaceContract<
  Procedures extends Record<string, unknown> = {},
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
> {
  [Kind]: typeof NamespaceKind
  type: 'neemata:namespace'
  name: Name
  procedures: {
    [K in keyof Procedures]: Procedures[K] extends TAnyProcedureContract
      ? TProcedureContract<
          Procedures[K]['input'],
          Procedures[K]['output'],
          Procedures[K]['stream'],
          Extract<K, string>,
          Name
        >
      : never
  }
  events: {
    [K in keyof Events]: Events[K] extends TAnyEventContract
      ? TEventContract<
          Events[K]['payload'],
          Extract<K, string>,
          undefined,
          Name
        >
      : never
  }
  timeout?: number
}

export const NamespaceContract = <
  Procedures extends Record<string, unknown> = {},
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
>(options?: {
  procedures?: Procedures
  events?: Events
  name?: Name
  timeout?: number
  schemaOptions?: ContractSchemaOptions
}) => {
  const {
    procedures = {} as Procedures,
    events = {} as Events,
    name,
    timeout,
    schemaOptions = {} as ContractSchemaOptions,
  } = options ?? {}
  const _events = {} as any

  for (const eventKey in events) {
    const event = events[eventKey]
    _events[eventKey] = Object.assign({}, event, {
      name: eventKey,
      namespace: options?.name,
    })
  }

  const _procedures = {} as any
  for (const procedureKey in procedures) {
    const procedure: any = procedures[procedureKey]
    _procedures[procedureKey] = Object.assign({}, procedure, {
      name: procedureKey,
      namespace: options?.name,
    })
  }

  return createSchema<TNamespaceContract<Procedures, Events, Name>>({
    ...schemaOptions,
    [Kind]: NamespaceKind,
    type: 'neemata:namespace',
    name: name as Name,
    procedures: _procedures,
    events: _events,
    timeout,
  })
}

export function IsNamespaceContract(
  value: any,
): value is TAnyNamespaceContract {
  return Kind in value && value[Kind] === NamespaceKind
}
