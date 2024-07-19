import { Kind, type TSchema } from '@sinclair/typebox/type'
import { type ContractSchemaOptions, createSchema } from '../utils.ts'
import type { TEventContract } from './event.ts'
import type { TBaseProcedureContract } from './procedure.ts'

export const SubscriptionKind = 'NeemataSubscription'

export type TSubcriptionOptions = { static: Record<string, string | number> }

export interface TSubscriptionContract<
  Input extends TSchema = TSchema,
  Output extends TSchema = TSchema,
  Options extends TSubcriptionOptions = TSubcriptionOptions,
  Events extends Record<string, TEventContract> = Record<
    string,
    TEventContract
  >,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  Transports extends { [K in string]?: true } | undefined =
    | { [K in string]?: true }
    | undefined,
> extends TBaseProcedureContract<Input, Output, Name, ServiceName, Transports> {
  [Kind]: typeof SubscriptionKind
  type: 'neemata:subscription'
  static: {
    input: Input['static']
    output: Output['static']
    options: Options['static']
    events: {
      [K in keyof Events]: Events[K]['static']
    }
  }
  options: Options
  events: Events
}

export const SubscriptionContract = <
  Input extends TSchema = TSchema,
  Output extends TSchema = TSchema,
  Options extends TSubcriptionOptions = TSubcriptionOptions,
  Events extends Record<string, TEventContract> = Record<
    string,
    TEventContract
  >,
  Name extends string | undefined = string | undefined,
  ServiceName extends string | undefined = string | undefined,
  Transports extends { [K in string]?: true } | undefined =
    | { [K in string]?: true }
    | undefined,
>(
  input: Input,
  output: Output,
  options: Options,
  events: Events,
  timeout?: number,
  schemaOptions: ContractSchemaOptions = {} as ContractSchemaOptions,
) =>
  createSchema<
    TSubscriptionContract<
      Input,
      Output,
      Options,
      Events,
      Name,
      ServiceName,
      Transports
    >
  >({
    ...schemaOptions,
    [Kind]: SubscriptionKind,
    type: 'neemata:subscription',
    input,
    output,
    events,
    options,
    timeout,
  })
