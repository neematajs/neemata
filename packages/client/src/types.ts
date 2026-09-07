import type {
  CallTypeProvider,
  Future,
  OneOf,
  TypeProvider,
} from '@nmtjs/common'
import type { WireSchema } from '@nmtjs/common/schema'
import type {
  TAnyProcedureContract,
  TAnyRouterContract,
  TRouteContract,
} from '@nmtjs/contract'
import type {
  ProtocolBlob,
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
  ProtocolVersion,
} from '@nmtjs/protocol'
import type {
  BaseClientFormat,
  ProtocolClientBlobStream,
  ProtocolError,
  ProtocolServerBlobStream,
} from '@nmtjs/protocol/client'

import type { ClientPlugin } from './plugins/types.ts'
import type { ClientStreams, ServerStreams } from './streams.ts'

export const ResolvedType: unique symbol = Symbol('ResolvedType')
export type ResolvedType = typeof ResolvedType

export interface ClientOptions<
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
> {
  contract: RouterContract
  protocol: ProtocolVersion
  format: BaseClientFormat
  application?: string
  autoConnect?: boolean
  timeout?: number
  /**
   * Backpressure defaults for streaming responses; individual calls override
   * them.
   */
  backpressure?: ClientBackpressureOptions
  plugins?: ClientPlugin[]
  safe?: SafeCall
}

export type BaseClientOptions<
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
> = ClientOptions<RouterContract, SafeCall>

export interface ClientCallersFactory<
  Routes extends AnyResolvedContractRouter,
  SafeCall extends boolean,
> {
  call: ClientCallers<Routes, SafeCall, false>
  stream: ClientCallers<Routes, SafeCall, true>
}

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'disconnected'

export interface ClientCoreOptions {
  protocol: ProtocolVersion
  format: BaseClientFormat
  application?: string
  autoConnect?: boolean
  plugins?: ClientPlugin[]
}

export type ProtocolClientCall = Future<any> & {
  procedure: string
  signal?: AbortSignal
  rpcStreamWindow: number
  cleanup?: () => void
}

export interface RpcLayerApi {
  call(
    procedure: string,
    payload: any,
    options?: ClientCallOptions,
  ): Promise<any>
  readonly pendingCallCount: number
  readonly activeStreamCount: number
}

export interface StreamLayerApi {
  readonly clientStreams: ClientStreams
  readonly serverStreams: ServerStreams
  getStreamId: () => number
  addClientStream: (blob: ProtocolBlob) => ProtocolClientBlobStream
  createServerBlob: (
    streamId: number,
    metadata: ProtocolBlobMetadata,
  ) => ProtocolBlobInterface
  addServerBlobStream: (
    metadata: ProtocolBlobMetadata,
    options?: {
      source?: ReadableStream<ArrayBufferView>
      start?: (
        stream: ProtocolServerBlobStream,
        options?: { signal?: AbortSignal },
      ) => void
    },
  ) => {
    blob: ProtocolBlobInterface
    streamId: number
    stream: ProtocolServerBlobStream
  }
  consumeServerBlob: (
    blob: ProtocolBlobInterface,
    options?: { signal?: AbortSignal },
  ) => ProtocolServerBlobStream
}

export interface PingLayerApi {
  ping(timeout: number, signal?: AbortSignal): Promise<void>
  stopAll(reason?: unknown): void
}

export type EventMap = { [K: string]: any[] }

export type RpcCallOptions = {
  timeout?: number
  signal?: AbortSignal
  /**
   * HTTP transport only: send with fetch keepalive so the request survives
   * page unload. Browsers cap total in-flight keepalive bytes at ~64KB,
   * so it is opt-in per call.
   */
  keepalive?: boolean
}

export type ClientBackpressureOptions = {
  rpc?: {
    /**
     * Maximum number of chunks a bidirectional RPC response stream may
     * produce ahead of the consumer. Credits count chunks, not bytes, so a
     * side-effectful producer may advance by up to this amount before client
     * cancellation arrives.
     *
     * Unidirectional transports use their native stream backpressure instead.
     * Larger windows proportionally extend the gateway's idle allowance once
     * the granted batch has been exhausted.
     * @default 16
     */
    window?: number
  }
}

export type StreamCallOptions = RpcCallOptions & {
  autoReconnect?: boolean
  /**
   * Overrides the client backpressure defaults for this stream.
   */
  backpressure?: ClientBackpressureOptions
}

export type ClientCallOptions = StreamCallOptions & {
  /**
   * @internal
   */
  _stream_response?: boolean
}

export type BlobSubscriptionOptions = { signal?: AbortSignal }

export type StreamSubscriptionOptions = Partial<StreamCallOptions>

/** Runtime clients require both codec directions at every nesting level. */
export type NonCodecSchemas<Route extends TRouteContract> =
  Route extends TAnyProcedureContract
    ? Exclude<Route['input'] | Route['output'], WireSchema.Codec | undefined>
    : Route extends TAnyRouterContract
      ? NonCodecSchemas<Route['routes'][keyof Route['routes']]>
      : never

export interface StaticInputContractTypeProvider extends TypeProvider {
  output: this['input'] extends WireSchema.Decode | WireSchema.Codec
    ? WireSchema.DecodeInput<this['input']>
    : undefined
}

export interface RuntimeInputContractTypeProvider extends TypeProvider {
  output: this['input'] extends WireSchema.Codec
    ? WireSchema.EncodeInput<this['input']>
    : undefined
}

export interface StaticOutputContractTypeProvider extends TypeProvider {
  output: this['input'] extends WireSchema.Encode | WireSchema.Codec
    ? WireSchema.EncodeOutput<this['input']>
    : undefined
}

export interface RuntimeOutputContractTypeProvider extends TypeProvider {
  output: this['input'] extends WireSchema.Codec
    ? WireSchema.DecodeOutput<this['input']>
    : undefined
}

export type AnyResolvedContractProcedure = {
  [ResolvedType]: 'procedure'
  contract: TAnyProcedureContract
  stream: boolean
  input: any
  output: any
}

export type AnyResolvedContractRouter = {
  [ResolvedType]: 'router'
  [key: string]: AnyResolvedContractProcedure | AnyResolvedContractRouter
}

export type ResolveAPIRouterRoutes<
  T extends TAnyRouterContract,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> = { [ResolvedType]: 'router' } & {
  [K in keyof T['routes']]: T['routes'][K] extends TAnyProcedureContract
    ? {
        [ResolvedType]: 'procedure'
        contract: T['routes'][K]
        stream: T['routes'][K]['stream'] extends true ? true : false
        input: CallTypeProvider<InputTypeProvider, T['routes'][K]['input']>
        output: T['routes'][K]['stream'] extends true
          ? AsyncIterable<
              CallTypeProvider<OutputTypeProvider, T['routes'][K]['output']>
            >
          : CallTypeProvider<OutputTypeProvider, T['routes'][K]['output']>
      }
    : T['routes'][K] extends TAnyRouterContract
      ? ResolveAPIRouterRoutes<
          T['routes'][K],
          InputTypeProvider,
          OutputTypeProvider
        >
      : never
}

export type ResolveContract<
  C extends TAnyRouterContract = TAnyRouterContract,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> = ResolveAPIRouterRoutes<C, InputTypeProvider, OutputTypeProvider>

export type ClientCaller<
  Procedure extends AnyResolvedContractProcedure,
  SafeCall extends boolean,
> = (
  ...args: Procedure['contract']['input'] extends undefined
    ? [
        data?: undefined,
        options?: Partial<
          Procedure['stream'] extends true ? StreamCallOptions : RpcCallOptions
        >,
      ]
    : undefined extends Procedure['input']
      ? [
          data?: Procedure['input'],
          options?: Partial<
            Procedure['stream'] extends true
              ? StreamCallOptions
              : RpcCallOptions
          >,
        ]
      : [
          data: Procedure['input'],
          options?: Partial<
            Procedure['stream'] extends true
              ? StreamCallOptions
              : RpcCallOptions
          >,
        ]
) => SafeCall extends true
  ? Promise<OneOf<[{ result: Procedure['output'] }, { error: ProtocolError }]>>
  : Promise<Procedure['output']>

type OmitType<T extends object, E> = {
  [K in keyof T as T[K] extends E ? never : K]: T[K]
}

export type ClientCallers<
  Resolved extends AnyResolvedContractRouter,
  SafeCall extends boolean,
  Stream extends boolean,
> = OmitType<
  {
    [K in keyof Resolved]: Resolved[K] extends AnyResolvedContractProcedure
      ? Stream extends (Resolved[K]['stream'] extends true ? true : false)
        ? ClientCaller<Resolved[K], SafeCall>
        : never
      : Resolved[K] extends AnyResolvedContractRouter
        ? ClientCallers<Resolved[K], SafeCall, Stream>
        : never
  },
  never
>
