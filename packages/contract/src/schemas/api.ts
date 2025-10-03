import type { ContractSchemaOptions } from '../utils.ts'
import type { TEventContract } from './event.ts'
import type { TAnyNamespaceContract, TNamespaceContract } from './namespace.ts'
import type { TProcedureContract } from './procedure.ts'
import { Kind } from '../constants.ts'
import { createSchema } from '../utils.ts'

export const APIKind = Symbol('NeemataAPI')

export type TAnyAPIContract = TAPIContract<
  Record<string, TAnyNamespaceContract>
>

export interface TAPIContract<
  Namespaces extends Record<string, TAnyNamespaceContract> = {},
> {
  readonly [Kind]: typeof APIKind
  readonly type: 'neemata:api'
  readonly namespaces: {
    [K in keyof Namespaces]: TNamespaceContract<
      Namespaces[K]['procedures'],
      Namespaces[K]['events'],
      Extract<K, string>
    >
  }
  readonly timeout?: number
}

export const APIContract = <
  const Options extends {
    namespaces: Record<string, TAnyNamespaceContract>
    timeout?: number
    schemaOptions?: ContractSchemaOptions
  },
>(
  options: Options,
) => {
  const { timeout, schemaOptions } = options

  const _namespaces = {} as any

  for (const namespaceKey in options.namespaces) {
    const namespace = options.namespaces[namespaceKey]
    const _procedures = {} as any
    for (const procedureKey in namespace.procedures) {
      const procedure = namespace.procedures[procedureKey]
      _procedures[procedureKey] = createSchema<
        TProcedureContract<
          (typeof procedure)['input'],
          (typeof procedure)['output'],
          (typeof procedure)['stream'],
          Extract<typeof procedureKey, string>,
          Extract<typeof namespaceKey, string>
        >
      >({ ...procedure, name: procedureKey, namespace: namespaceKey })
    }

    const _events = {} as any
    for (const eventKey in namespace.events) {
      const event = namespace.events[eventKey]
      _events[eventKey] = createSchema<
        TEventContract<
          (typeof event)['payload'],
          Extract<typeof eventKey, string>,
          undefined,
          Extract<typeof namespaceKey, string>
        >
      >({
        ...event,
        subscription: undefined,
        name: eventKey,
        namespace: namespaceKey,
      })
    }

    _namespaces[namespaceKey] = createSchema<
      TNamespaceContract<
        typeof _procedures,
        typeof _events,
        Extract<typeof namespaceKey, string>
      >
    >({
      ...namespace,
      procedures: _procedures,
      events: _events,
      name: namespaceKey,
    })
  }

  return createSchema<TAPIContract<Options['namespaces']>>({
    ...schemaOptions,
    [Kind]: APIKind,
    type: 'neemata:api',
    namespaces: _namespaces,
    timeout,
  })
}

export function IsAPIContract(value: any): value is TAnyAPIContract {
  return Kind in value && value[Kind] === APIKind
}
