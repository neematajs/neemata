import type { TypeProvider } from '@nmtjs/common'
import type { TAnyRouterContract } from '@nmtjs/contract'
import type {
  ProtocolBlobInterface,
  ProtocolBlobMetadata,
} from '@nmtjs/protocol'
import type { ProtocolServerBlobStream } from '@nmtjs/protocol/client'
import { noopFn } from '@nmtjs/common'
import { ProtocolBlob } from '@nmtjs/protocol'

import type { BaseClientTransformer } from './transformers.ts'
import type { ClientTransportFactory } from './transport.ts'
import type {
  ClientOptions,
  ClientCoreOptions,
  ConnectionState,
  PingLayerApi,
  RpcLayerApi,
  StreamLayerApi,
  ClientCallers,
  ResolveContract,
} from './types.ts'
import { ClientCore } from './core.ts'
import { createPingLayer } from './layers/ping.ts'
import { createRpcLayer } from './layers/rpc.ts'
import { createStreamLayer } from './layers/streams.ts'

export class Client<
  TransportFactory extends ClientTransportFactory<any, any> =
    ClientTransportFactory<any, any>,
  RouterContract extends TAnyRouterContract = TAnyRouterContract,
  SafeCall extends boolean = false,
  InputTypeProvider extends TypeProvider = TypeProvider,
  OutputTypeProvider extends TypeProvider = TypeProvider,
> {
  _!: {
    routes: ResolveContract<
      RouterContract,
      InputTypeProvider,
      OutputTypeProvider
    >
    safe: SafeCall
  }

  readonly core: ClientCore
  protected readonly rpcLayer: RpcLayerApi
  protected readonly streamLayer: StreamLayerApi
  protected readonly pingLayer: PingLayerApi
  protected readonly transformer: BaseClientTransformer

  readonly call: ClientCallers<
    ResolveContract<RouterContract, InputTypeProvider, OutputTypeProvider>,
    SafeCall,
    false
  >
  readonly stream: ClientCallers<
    ResolveContract<RouterContract, InputTypeProvider, OutputTypeProvider>,
    SafeCall,
    true
  >

  readonly on: ClientCore['on']
  readonly once: ClientCore['once']
  readonly off: ClientCore['off']

  constructor(
    readonly options: ClientOptions<RouterContract, SafeCall>,
    readonly transportFactory: TransportFactory,
    readonly transportOptions: TransportFactory extends ClientTransportFactory<
      any,
      infer Options
    >
      ? Options
      : never,
    transformer: BaseClientTransformer,
    buildCallers: (rpc: RpcLayerApi) => { call: unknown; stream: unknown },
  ) {
    this.transformer = transformer

    const transport = this.transportFactory(
      { protocol: this.options.protocol, codec: this.options.codec },
      this.transportOptions,
    )

    const coreOptions: ClientCoreOptions = {
      protocol: this.options.protocol,
      codec: this.options.codec,
      application: this.options.application,
      autoConnect: this.options.autoConnect,
    }

    this.core = new ClientCore(coreOptions, transport)
    this.streamLayer = createStreamLayer(this.core)
    this.rpcLayer = createRpcLayer(this.core, this.streamLayer, transformer, {
      timeout: this.options.timeout,
      rpcStreamWindow: this.options.backpressure?.rpc?.window,
      safe: this.options.safe,
    })
    this.pingLayer = createPingLayer(this.core)

    this.core.setMessageContextFactory(() => ({
      encoder: this.core.codec,
      decoder: this.core.codec,
      transport: {
        send: (buffer) => {
          this.core.send(buffer).catch(noopFn)
        },
      },
      streamId: () => this.streamLayer.getStreamId(),
      addClientStream: (blob) => this.streamLayer.addClientStream(blob),
      addServerStream: (streamId, metadata) =>
        this.streamLayer.createServerBlob(streamId, metadata),
    }))

    this.core.initPlugins(this.options.plugins, {
      core: this.core,
      ping: this.pingLayer,
    })

    const callers = buildCallers(this.rpcLayer)
    this.call = callers.call as ClientCallers<
      ResolveContract<RouterContract, InputTypeProvider, OutputTypeProvider>,
      SafeCall,
      false
    >
    this.stream = callers.stream as ClientCallers<
      ResolveContract<RouterContract, InputTypeProvider, OutputTypeProvider>,
      SafeCall,
      true
    >

    this.on = this.core.on.bind(this.core)
    this.once = this.core.once.bind(this.core)
    this.off = this.core.off.bind(this.core)
  }

  get state(): ConnectionState {
    return this.core.state
  }

  get transportType() {
    return this.core.transportType
  }

  get lastDisconnectReason() {
    return this.core.lastDisconnectReason
  }

  get auth() {
    return this.core.auth
  }

  set auth(value: any) {
    this.core.auth = value
  }

  isDisposed() {
    return this.core.isDisposed()
  }

  connect() {
    return this.core.connect()
  }

  disconnect() {
    return this.core.disconnect()
  }

  ping(timeout: number, signal?: AbortSignal) {
    return this.pingLayer.ping(timeout, signal)
  }

  createBlob(
    source: Blob | ReadableStream | string | AsyncIterable<Uint8Array>,
    metadata?: ProtocolBlobMetadata,
  ) {
    return ProtocolBlob.from(source, metadata)
  }

  consumeBlob(
    blob: ProtocolBlobInterface,
    options?: { signal?: AbortSignal },
  ): ProtocolServerBlobStream {
    return this.streamLayer.consumeServerBlob(blob, options)
  }

  dispose() {
    this.core.dispose()
  }
}
