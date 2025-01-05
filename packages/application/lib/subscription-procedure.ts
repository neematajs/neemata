import {
  type SubcriptionOptions,
  type TEventContract,
  type TSubscriptionContract,
  c,
} from '@nmtjs/contract'
import { type BaseType, type CustomType, type NeverType, t } from '@nmtjs/type'

import { kProcedureSubscription } from './constants.ts'
import type { Dependencies, DependencyContext } from './container.ts'
import {
  type AnyGuard,
  type AnyMiddleware,
  type BaseProcedure,
  type Metadata,
  _createBaseProcedure,
} from './procedure.ts'
import type { Subscription, SubscriptionResponse } from './subscription.ts'
import type { Async, InputType, JsonPrimitive, OutputType } from './types.ts'

export type SubscriptionHandlerType<
  Input,
  Output,
  Contract extends TSubscriptionContract,
  Deps extends Dependencies,
> = (
  ctx: DependencyContext<Deps>,
  data: Input,
  contract: Contract,
) => Async<SubscriptionResponse<Contract>>

export interface SubscriptionProcedure<
  ProcedureContract extends TSubscriptionContract = TSubscriptionContract,
  ProcedureDeps extends Dependencies = Dependencies,
> extends BaseProcedure<ProcedureContract, ProcedureDeps> {
  handler: SubscriptionHandlerType<
    ProcedureContract['input'] extends NeverType
      ? never
      : InputType<t.infer.decoded<ProcedureContract['input']>>,
    ProcedureContract['output'] extends NeverType
      ? never
      : OutputType<t.infer.input.decoded<ProcedureContract['output']>>,
    TSubscriptionContract<
      ProcedureContract['input'],
      ProcedureContract['output'],
      ProcedureContract['options'],
      ProcedureContract['events'],
      string,
      string
    >,
    ProcedureDeps
  >
  [kProcedureSubscription]: any
}

export function createContractSubscription<
  ProcedureContract extends TSubscriptionContract = TSubscriptionContract,
  ProcedureDeps extends Dependencies = Dependencies,
>(
  contract: ProcedureContract,
  paramsOrHandler:
    | {
        dependencies?: ProcedureDeps
        guards?: AnyGuard[]
        middlewares?: AnyMiddleware[]
        metadata?: Metadata[]
        handler: SubscriptionHandlerType<
          InputType<t.infer.decoded<ProcedureContract['input']>>,
          OutputType<t.infer.input.decoded<ProcedureContract['output']>>,
          TSubscriptionContract,
          ProcedureDeps
        >
      }
    | SubscriptionHandlerType<
        InputType<t.infer.decoded<ProcedureContract['input']>>,
        OutputType<t.infer.input.decoded<ProcedureContract['output']>>,
        TSubscriptionContract,
        ProcedureDeps
      >,
): SubscriptionProcedure<ProcedureContract, ProcedureDeps> {
  const { handler, ...params } =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler

  const procedure = _createBaseProcedure(contract, params)

  return Object.assign(procedure, {
    handler,
    [kProcedureSubscription]: true,
  }) as any
}

export function $createSubscription<T extends SubcriptionOptions>() {
  return <
    R,
    I extends BaseType | undefined = undefined,
    O extends BaseType | undefined = undefined,
    E extends Record<string, BaseType> = {},
    D extends Dependencies = {},
    CI extends I extends BaseType ? I : NeverType = I extends BaseType
      ? I
      : NeverType,
    CO extends O extends BaseType
      ? O
      : CustomType<R, JsonPrimitive<R>> = O extends BaseType
      ? O
      : CustomType<R, JsonPrimitive<R>>,
    CE extends {
      [K in keyof E]: TEventContract<E[K]>
    } = {
      [K in keyof E]: TEventContract<E[K]>
    },
  >(
    paramsOrHandler:
      | {
          input?: I
          output?: O
          dependencies?: D
          guards?: AnyGuard[]
          middlewares?: AnyMiddleware[]
          metadata?: Metadata[]
          events?: E
          handler: SubscriptionHandlerType<
            I extends BaseType ? InputType<t.infer.decoded<I>> : never,
            O extends BaseType ? OutputType<t.infer.input.decoded<O>> : R,
            TSubscriptionContract<CI, CO, T, CE>,
            D
          >
        }
      | SubscriptionHandlerType<
          I extends BaseType ? InputType<t.infer.decoded<I>> : never,
          O extends BaseType ? OutputType<t.infer.input.decoded<O>> : R,
          TSubscriptionContract<CI, CO, T, CE>,
          D
        >,
  ): SubscriptionProcedure<TSubscriptionContract<CI, CO, T, CE>, D> => {
    const { input, output, events, ...params } =
      typeof paramsOrHandler === 'function'
        ? {
            handler: paramsOrHandler,
            input: undefined,
            output: undefined,
            events: undefined,
          }
        : paramsOrHandler

    const contractEvents: any = {}

    for (const [key, value] of Object.entries(events ?? {})) {
      contractEvents[key] = c.event(value)
    }

    const contract = c
      .subscription(input ?? t.never(), output ?? t.any(), contractEvents)
      .$withOptions<T>()

    return createContractSubscription(contract, params as any) as any
  }
}
