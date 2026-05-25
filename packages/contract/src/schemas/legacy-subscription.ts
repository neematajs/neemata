import type { ContractSchemaOptions } from '../utils.ts'
import type { TAnyEventContract, TEventContract } from './event.ts'
import { Kind } from '../constants.ts'
import { concatFullName, createSchema } from '../utils.ts'

export const LegacySubscriptionKind = Symbol('NeemataSubscription')

export type SubcriptionOptions = Record<
  string,
  string | number | boolean
> | null

export type TAnyLegacySubscriptionContract = TLegacySubscriptionContract<
  SubcriptionOptions,
  Record<string, TAnyEventContract>,
  string | undefined
>

export interface TLegacySubscriptionContract<
  Options extends SubcriptionOptions = null,
  Events extends Record<string, unknown> = {},
  Name extends string | undefined = undefined,
> {
  readonly [Kind]: typeof LegacySubscriptionKind
  readonly type: 'neemata:subscription'
  readonly name: Name
  readonly options: Options
  readonly events: {
    [K in keyof Events]: Events[K] extends TAnyEventContract
      ? TEventContract<
          Events[K]['payload'],
          Name extends string
            ? `${Name}/${Extract<K, string>}`
            : Extract<K, string>,
          Options
        >
      : never
  }
}

const _LegacySubscriptionContract = <
  const Options extends {
    events: Record<string, TAnyEventContract>
    name?: string
    schemaOptions?: ContractSchemaOptions
  },
  SubOpt extends SubcriptionOptions = null,
>(
  options: Options,
) => {
  const { schemaOptions = {}, name } = options
  const _events = {} as any
  for (const key in options.events) {
    const event = options.events[key]
    const fullName = concatFullName(name, key)
    _events[key] = createSchema({ ...event, name: fullName })
  }
  return createSchema<
    TLegacySubscriptionContract<SubOpt, Options['events'], Options['name']>
  >({
    ...schemaOptions,
    [Kind]: LegacySubscriptionKind,
    type: 'neemata:subscription',
    events: _events,
    name,
    options: undefined as unknown as SubOpt,
  })
}

export const _legacy_SubscriptionContract = Object.assign(
  _LegacySubscriptionContract,
  {
    withOptions: <Options extends SubcriptionOptions>() => {
      return <
        T extends {
          events: Record<string, TAnyEventContract>
          name?: string
          schemaOptions?: ContractSchemaOptions
        },
      >(
        options: T,
      ) => _LegacySubscriptionContract<T, Options>(options)
    },
  },
)

export function IsLegacySubscriptionContract(
  contract: any,
): contract is TAnyLegacySubscriptionContract {
  return Kind in contract && contract[Kind] === LegacySubscriptionKind
}
