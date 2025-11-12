// import type { Callback } from '@nmtjs/common'
// import { throwError } from '@nmtjs/common'

// import type { ProtocolBlob, ProtocolBlobMetadata } from '../common/blob.ts'
// import type { GatewayConnections } from './connections.ts'
// import {
//   ProtocolClientStream,
//   ProtocolServerStream,
// } from './server/protocol/stream.ts'

// export class GatewayClientStreams {
//   constructor(private readonly connections: GatewayConnections) {}

//   get(connectionId: string, streamId: number) {
//     const { clientStreams } = this.connections.get(connectionId)
//     const stream = clientStreams.get(streamId) ?? throwError('Stream not found')
//     return stream
//   }

//   remove(connectionId: string, streamId: number) {
//     const { clientStreams } = this.connections.get(connectionId)
//     clientStreams.get(streamId) || throwError('Stream not found')
//     clientStreams.delete(streamId)
//   }

//   add(
//     connectionId: string,
//     streamId: number,
//     metadata: ProtocolBlobMetadata,
//     read: Callback,
//   ) {
//     const { clientStreams } = this.connections.get(connectionId)
//     const stream = new ProtocolClientStream(streamId, metadata, { read })
//     clientStreams.set(streamId, stream)
//     return stream
//   }

//   push(connectionId: string, streamId: number, chunk: ArrayBuffer) {
//     const stream = this.get(connectionId, streamId)
//     stream.write(Buffer.from(chunk))
//   }

//   end(connectionId: string, streamId: number) {
//     const stream = this.get(connectionId, streamId)
//     stream.end(null)
//     this.remove(connectionId, streamId)
//   }

//   abort(connectionId: string, streamId: number, error = new Error('Aborted')) {
//     const stream = this.get(connectionId, streamId)
//     stream.destroy(error)
//     this.remove(connectionId, streamId)
//   }
// }

// export class GatewayServerStreams {
//   constructor(private readonly connections: GatewayConnections) {}

//   get(connectionId: string, streamId: number) {
//     const { serverStreams } = this.connections.get(connectionId)
//     const stream = serverStreams.get(streamId) ?? throwError('Stream not found')
//     return stream
//   }

//   add(connectionId: string, streamId: number, blob: ProtocolBlob) {
//     const { serverStreams } = this.connections.get(connectionId)
//     const stream = new ProtocolServerStream(streamId, blob)
//     serverStreams.set(streamId, stream)
//     return stream
//   }

//   remove(connectionId: string, streamId: number) {
//     const { serverStreams } = this.connections.get(connectionId)
//     serverStreams.has(streamId) || throwError('Stream not found')
//     serverStreams.delete(streamId)
//   }

//   pull(connectionId: string, streamId: number) {
//     const stream = this.get(connectionId, streamId)
//     stream.resume()
//   }

//   abort(connectionId: string, streamId: number, error = new Error('Aborted')) {
//     const stream = this.get(connectionId, streamId)
//     stream.destroy(error)
//     this.remove(connectionId, streamId)
//   }
// }
