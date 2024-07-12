import {
  Kind,
  type TNumber,
  type TObject,
  type TSchema,
  type TString,
} from '@sinclair/typebox/type'
import { type NeemataContractSchemaOptions, createSchema } from '../utils'

export const SubscriptionKind = 'NeemataSubscription'

export type TSubcriptionOptions = TObject<Record<string, TNumber | TString>>

export interface TSubscriptionContract<
  // Input extends TSchema = TSchema,
  Options extends TSubcriptionOptions = TSubcriptionOptions,
  Events extends Record<string, TSchema> = Record<string, TSchema>,
> extends TSchema {
  [Kind]: typeof SubscriptionKind
  type: 'neemata:subscription'
  static: {
    // input: Input['static']
    options: Options['static']
    events: { [K in keyof Events]: Events[K]['static'] }
  }
  // input: Input
  events: Events
  options: Options
}

export const SubscriptionContract = <
  // Input extends TSchema,
  Options extends TSubcriptionOptions,
  Events extends Record<string, TSchema>,
  SOptions extends NeemataContractSchemaOptions,
>(
  // input: Input,
  options: Options,
  events: Events,
  schemaOptions: SOptions = {} as SOptions,
) =>
  createSchema<
    TSubscriptionContract<
      // Input,
      Options,
      Events
    >
  >({
    ...schemaOptions,
    [Kind]: SubscriptionKind,
    type: 'neemata:subscription',
    // input,
    events,
    options,
  })
