import { Kind } from '../constants.ts'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'
import type { TAnyProcedureContract, TProcedureContract } from './procedure.ts'

export const NamespaceKind = Symbol('NeemataNamespace')

export type TAnyNamespaceContract<
  Procedures extends Record<string, TAnyProcedureContract> = Record<
    string,
    TAnyProcedureContract
  >,
> = TNamespaceContract<
  Procedures,
  Record<string, TAnyEventContract>,
  string | undefined
>

export interface TNamespaceContract<
  Procedures extends Record<string, TAnyProcedureContract> = {},
  Events extends Record<string, TAnyEventContract> = {},
  Name extends string | undefined = undefined,
> {
  readonly [Kind]: typeof NamespaceKind
  readonly type: 'neemata:namespace'
  readonly name: Name
  readonly procedures: {
    [K in keyof Procedures]: TProcedureContract<
      Procedures[K]['input'],
      Procedures[K]['output'],
      Procedures[K]['stream'],
      Extract<K, string>,
      Name
    >
  }
  readonly events: {
    [K in keyof Events]: TEventContract<
      Events[K]['payload'],
      Extract<K, string>,
      undefined,
      Name
    >
  }
  readonly timeout?: number
}

export const NamespaceContract = <
  const Options extends {
    procedures: Record<string, TAnyProcedureContract>
    events: Record<string, TAnyEventContract>
    name?: string
    timeout?: number
    schemaOptions?: ContractSchemaOptions
  },
>(
  options: Options,
) => {
  const { name, timeout, schemaOptions = {} as ContractSchemaOptions } = options
  const events: Record<string, any> = {}

  for (const name in options.events) {
    const event = options.events[name]
    events[name] = createSchema<
      TEventContract<
        (typeof event)['payload'],
        Extract<typeof name, string>,
        undefined,
        Options['name'] extends string ? Options['name'] : undefined
      >
    >({
      ...event,
      subscription: undefined,
      name: name as any,
      namespace: options?.name as any,
    })
  }

  const procedures: Record<string, any> = {}

  for (const name in options.procedures) {
    const procedure: any = options.procedures[name]
    procedures[name] = createSchema<
      TProcedureContract<
        (typeof procedure)['input'],
        (typeof procedure)['output'],
        (typeof procedure)['stream'],
        Extract<typeof name, string>,
        Options['name'] extends string ? Options['name'] : undefined
      >
    >({
      ...procedure,
      name: name as any,
      namespace: options?.name as any,
    })
  }

  return createSchema<
    TNamespaceContract<
      Options['procedures'],
      Options['events'],
      Options['name'] extends string ? Options['name'] : undefined
    >
  >({
    ...schemaOptions,
    [Kind]: NamespaceKind,
    type: 'neemata:namespace',
    name: name as any,
    procedures: procedures as any,
    events: events as any,
    timeout,
  })
}

export function IsNamespaceContract(
  value: any,
): value is TAnyNamespaceContract {
  return Kind in value && value[Kind] === NamespaceKind
}
