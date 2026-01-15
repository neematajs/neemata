import type {
  ConnectionType,
  ProtocolBlobMetadata,
  ProtocolVersion,
} from '@nmtjs/protocol'
import type { BaseClientFormat } from '@nmtjs/protocol/client'

export type ClientTransportMessageOptions = {
  signal?: AbortSignal
  _stream_response?: boolean
}

export interface ClientTransportStartParams {
  auth?: string
  application?: string
  onMessage: (message: ArrayBufferView) => any
  onConnect: () => any
  onDisconnect: (reason: 'client' | 'server' | (string & {})) => any
}

export interface ClientTransportRpcParams {
  format: BaseClientFormat
  auth?: string
  application?: string
}

export type ClientCallResponse =
  | { type: 'rpc'; result: ArrayBufferView }
  | { type: 'rpc_stream'; stream: ReadableStream<ArrayBufferView> }
  | {
      type: 'blob'
      metadata: ProtocolBlobMetadata
      source: ReadableStream<ArrayBufferView>
    }

export type ClientTransport<T extends ConnectionType = ConnectionType> =
  T extends ConnectionType.Bidirectional
    ? {
        type: ConnectionType.Bidirectional
        connect(params: ClientTransportStartParams): Promise<void>
        disconnect(): Promise<void>
        send(
          message: ArrayBufferView,
          options: ClientTransportMessageOptions,
        ): Promise<void>
      }
    : {
        type: ConnectionType.Unidirectional
        connect?(params: ClientTransportStartParams): Promise<void>
        disconnect?(): Promise<void>
        call(
          client: {
            format: BaseClientFormat
            auth?: string
            application?: string
          },
          rpc: { callId: number; procedure: string; payload: any },
          options: ClientTransportMessageOptions,
        ): Promise<ClientCallResponse>
      }

export interface ClientTransportParams {
  protocol: ProtocolVersion
  format: BaseClientFormat
}

export type ClientTransportFactory<
  Type extends ConnectionType,
  Options = unknown,
  Transport extends ClientTransport<Type> = ClientTransport<Type>,
> = (params: ClientTransportParams, options: Options) => Transport
