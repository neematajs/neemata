import type {
  ConnectionType,
  ProtocolBlobMetadata,
  ProtocolVersion,
} from '@nmtjs/protocol'
import type { BaseClientFormat } from '@nmtjs/protocol/client'

export type ClientDisconnectReason = 'client' | 'server' | (string & {})

export interface TransportConnectParams {
  auth?: string
  application?: string
  onMessage: (message: ArrayBufferView) => void
  onConnect: () => void
  onDisconnect: (reason: ClientDisconnectReason) => void
}

export interface TransportSendOptions {
  signal?: AbortSignal
}

export interface TransportCallContext {
  contentType: string
  auth?: string
  application?: string
}

export interface TransportRpcParams {
  callId: number
  procedure: string
  payload: ArrayBufferView
  blob?: { source: ReadableStream; metadata: ProtocolBlobMetadata }
}

export interface TransportCallOptions {
  signal?: AbortSignal
  streamResponse?: boolean
}

export interface TransportRpcResponse {
  type: 'rpc'
  result: ArrayBufferView
}

export interface TransportRpcStreamResponse {
  type: 'rpc_stream'
  stream: ReadableStream<ArrayBufferView>
}

export interface TransportBlobResponse {
  type: 'blob'
  metadata: ProtocolBlobMetadata
  source: ReadableStream<ArrayBufferView>
}

export interface TransportErrorResponse {
  type: 'error'
  error: ArrayBufferView
  status?: number
  statusText?: string
}

export type TransportCallResponse =
  | TransportRpcResponse
  | TransportRpcStreamResponse
  | TransportBlobResponse
  | TransportErrorResponse

export interface BidirectionalTransport {
  type: ConnectionType.Bidirectional
  connect(params: TransportConnectParams): Promise<void>
  disconnect(): Promise<void>
  send(message: ArrayBufferView, options: TransportSendOptions): Promise<void>
}

export interface UnidirectionalTransport {
  type: ConnectionType.Unidirectional
  call(
    context: TransportCallContext,
    rpc: TransportRpcParams,
    options: TransportCallOptions,
  ): Promise<TransportCallResponse>
}

export type ClientTransport = BidirectionalTransport | UnidirectionalTransport

export interface ClientTransportParams {
  protocol: ProtocolVersion
  format: BaseClientFormat
}

export type ClientTransportFactory<
  Transport extends ClientTransport = ClientTransport,
  Options = unknown,
> = (params: ClientTransportParams, options: Options) => Transport

export type ClientTransportMessageOptions = TransportSendOptions
export type ClientTransportStartParams = TransportConnectParams
export type ClientTransportRpcParams = TransportCallContext
export type ClientCallResponse = TransportCallResponse
