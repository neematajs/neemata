// import type { ProtocolRPCResponse } from '@nmtjs/protocol'
// import type {
//   BaseClientFormat,
//   ProtocolServerBlobStream,
//   ProtocolServerStream,
//   ProtocolVersionInterface,
// } from '@nmtjs/protocol/client'
// import { createPromise } from '@nmtjs/common'
// import { ErrorCode } from '@nmtjs/protocol'
// import { ProtocolError } from '@nmtjs/protocol/client'

import type { Async } from '@nmtjs/common'
import type { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'
import type { BaseClientFormat } from '@nmtjs/protocol/client'

// import type { BaseClientTransformer } from './transformers.ts'
// import { EventEmitter } from './events.ts'
// import { ClientStreams, ServerStreams } from './streams.ts'

// export abstract class BaseClientTransport extends EventEmitter {
//   protected readonly clientStreams: ClientStreams = new ClientStreams()
//   protected readonly serverStreams: ServerStreams<ProtocolServerBlobStream> =
//     new ServerStreams()
//   protected readonly rpcStreams: ServerStreams = new ServerStreams()
//   protected readonly calls = new Map<number, ProtocolClientCall>()
//   protected callId = 0
//   protected streamId = 0

//   constructor(
//     public readonly format: BaseClientFormat,
//     public readonly protocol: ProtocolVersionInterface,
//   ) {
//     super()
//   }

//   // get contentType() {
//   //   return this.format.contentType
//   // }

//   handleMessage(
//     message: ArrayBuffer
//   ) {

//     // if (error) {
//     //   call.reject(
//     //     new ProtocolError(
//     //       response.result.code,
//     //       response.result.message,
//     //       response.result.data,
//     //     ),
//     //   )
//     // } else {
//     //   try {
//     //     const transformed = transformer.decode(call.procedure, response.result)
//     //     if (response.stream)
//     //       call.resolve({ result: transformed, stream: response.stream })
//     //     else call.resolve(transformed)
//     //   } catch (error) {
//     //     call.reject(
//     //       new ProtocolError(
//     //         ErrorCode.ClientRequestError,
//     //         'Unable to decode response',
//     //         error,
//     //       ),
//     //     )
//     //   }
//     // }
//     // this.calls.delete(callId)
//   }

//   // handleRpcResponse(
//   //   callId: number,
//   //   error: boolean,
//   //   { result, streams }: ProtocolRPCResponse,
//   //   transformer: BaseClientTransformer,
//   //   stream?: ProtocolServerStream,
//   // ) {
//   //   const call = this.calls.get(callId)
//   //   if (!call) throw new Error('Call not found')
//   //   for (const key in streams) {
//   //     const stream = streams[key]
//   //     this.serverStreams.add(stream.id, stream)
//   //   }
//   //   this.handleCallResponse(
//   //     callId,
//   //     call,
//   //     error,
//   //     { result, stream },
//   //     transformer,
//   //   )
//   //   return call
//   // }

//   // handleRpcStreamResponse(
//   //   callId: number,
//   //   response: ProtocolRPCResponse,
//   //   stream: ProtocolServerStream,
//   //   transformer: ProtocolBaseTransformer,
//   // ) {
//   //   const call = this.handleRpcResponse(
//   //     callId,
//   //     false,
//   //     response,
//   //     transformer,
//   //     stream,
//   //   )
//   //   this.rpcStreams.add(callId, stream)
//   //   return call
//   // }

//   // createCall(procedure: string, options: ProtocolBaseClientCallOptions) {
//   //   const timeoutSignal = AbortSignal.timeout(options.timeout)
//   //   const signal = options.signal
//   //     ? AbortSignal.any([options.signal, timeoutSignal])
//   //     : timeoutSignal

//   //   const call = Object.assign(createPromise(), { procedure, signal })

//   //   timeoutSignal.addEventListener(
//   //     'abort',
//   //     () => {
//   //       const error = new ProtocolError(
//   //         ErrorCode.RequestTimeout,
//   //         'Request timeout',
//   //       )
//   //       call.reject(error)
//   //     },
//   //     { once: true },
//   //   )

//   //   return call
//   // }

//   // createRpc(
//   //   procedure: string,
//   //   payload: any,
//   //   options: ProtocolBaseClientCallOptions,
//   //   format: BaseClientFormat,
//   //   transformer: BaseClientTransformer,
//   // ) {
//   //   const callId = ++this.callId
//   //   const call = this.createCall(procedure, options)
//   //   const { buffer, streams } = format.encodeRPC(
//   //     { callId, procedure, payload: transformer.encode(procedure, payload) },
//   //     {
//   //       addStream: (blob) => {
//   //         const streamId = ++this.streamId
//   //         return this.clientStreams.add(blob.source, streamId, blob.metadata)
//   //       },
//   //       getStream: (id) => {
//   //         const stream = this.clientStreams.get(id)
//   //         return stream
//   //       },
//   //     },
//   //   )

//   //   this.calls.set(callId, call)

//   //   return { callId, call, streams, buffer }
//   // }

//   // pushRpcStream(callId: number, chunk: any) {
//   //   this.rpcStreams.push(callId, chunk)
//   // }

//   // endRpcStream(callId: number) {
//   //   this.rpcStreams.end(callId)
//   // }

//   // abortRpcStream(callId: number) {
//   //   this.rpcStreams.abort(callId)
//   // }

//   // removeClientStream(streamId: number) {
//   //   this.clientStreams.remove(streamId)
//   // }

//   // pullClientStream(streamId: number, size: number) {
//   //   return this.clientStreams.pull(streamId, size)
//   // }

//   // endClientStream(streamId: number) {
//   //   this.clientStreams.end(streamId)
//   // }

//   // abortClientStream(streamId: number, error?: Error) {
//   //   this.clientStreams.abort(streamId, error)
//   // }

//   // addServerStream(stream: ProtocolServerBlobStream) {
//   //   this.serverStreams.add(stream.id, stream)
//   // }

//   // removeServerStream(streamId: number) {
//   //   this.serverStreams.remove(streamId)
//   // }

//   // pushServerStream(streamId: number, chunk: ArrayBuffer) {
//   //   return this.serverStreams.push(streamId, chunk)
//   // }

//   // endServerStream(streamId: number) {
//   //   this.serverStreams.end(streamId)
//   // }

//   // abortServerStream(streamId: number, _error?: Error) {
//   //   this.serverStreams.abort(streamId)
//   // }

//   // emitEvent(
//   //   event: string,
//   //   payload: string,
//   //   transformer: BaseClientTransformer,
//   // ) {
//   //   const transformed = transformer.decode(event, payload)
//   //   this.emit(
//   //     event,
//   //     //@ts-expect-error
//   //     transformed,
//   //   )
//   // }
// }

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

export type ClientTransportInstance<T extends ConnectionType = ConnectionType> =
  T extends ConnectionType.Bidirectional
    ? {
        connect(params: ClientTransportStartParams): Promise<void>
        disconnect(): Promise<void>
        send(message: ArrayBufferView, signal: AbortSignal): Promise<void>
      }
    : {
        connect?(params: ClientTransportStartParams): Promise<void>
        disconnect?(): Promise<void>
        call(
          params: {
            format: BaseClientFormat
            auth?: string
            application?: string
          },
          rpc: { callId: number; procedure: string; payload: any },
          signal: AbortSignal,
        ): Promise<unknown>
      }

export interface ClientTransportParams {
  protocol: ProtocolVersion
  format: BaseClientFormat
}

export interface ClientTransport<
  Type extends ConnectionType,
  Options = unknown,
> {
  type: Type
  factory(
    params: ClientTransportParams,
    options: Options,
  ): Async<ClientTransportInstance>
}
