import type {
  Decoded,
  DownStream as DownStreamType,
  TServiceContract,
  TSubscriptionContract,
  UpStream as UpStreamType,
} from '@neematajs/contract'
import type { DownStream, UpStream } from './stream.ts'
import type { Subscription } from './subscription.ts'

export type ClientCallOptions = {
  signal?: AbortSignal
}

export type InputType<T> = T extends any[]
  ? Array<InputType<T[number]>>
  : T extends object
    ? { [K in keyof T]: InputType<T[K]> }
    : T extends UpStreamType
      ? UpStream
      : T

export type OutputType<T> = T extends DownStreamType<any, any, infer C>
  ? DownStream<C>
  : T

export type ClientServices = Record<string, TServiceContract>

export type ClientCallers<Services extends ClientServices> = {
  [K in keyof Services]: {
    [P in keyof Services[K]['procedures']]: (
      ...args: Services[K]['procedures'][P]['static']['input'] extends never
        ? [ClientCallOptions?]
        : [
            InputType<Decoded<Services[K]['procedures'][P]['input']>>,
            ClientCallOptions?,
          ]
    ) => Promise<
      Services[K]['procedures'][P] extends TSubscriptionContract
        ? {
            payload: Services[K]['procedures'][P]['output']['static'] extends never
              ? Services[K]['procedures'][P]['output']['static']
              : undefined
            subscription: Subscription<Services[K]['procedures'][P]>
          }
        : Services[K]['procedures'][P]['static']['output'] extends never
          ? void
          : OutputType<Decoded<Services[K]['procedures'][P]['output']>>
    >
  }
}
