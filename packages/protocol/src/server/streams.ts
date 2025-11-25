import type { Callback } from '@nmtjs/common'
import { throwError } from '@nmtjs/common'

import type { ProtocolBlob, ProtocolBlobMetadata } from '../common/blob.ts'
import { ProtocolClientStream, ProtocolServerStream } from './stream.ts'

export class ProtocolClientStreams {
  constructor(private readonly streams: Map<number, ProtocolClientStream>) {}

  get(streamId: number) {
    const stream = this.streams.get(streamId) ?? throwError('Stream not found')
    return stream
  }

  remove(streamId: number) {
    this.streams.get(streamId) || throwError('Stream not found')
    this.streams.delete(streamId)
  }

  add(streamId: number, metadata: ProtocolBlobMetadata, read: Callback) {
    const stream = new ProtocolClientStream(streamId, metadata, { read })
    this.streams.set(streamId, stream)
    return stream
  }

  push(streamId: number, chunk: ArrayBufferView) {
    const stream = this.get(streamId)
    stream.write(chunk)
  }

  end(streamId: number) {
    const stream = this.get(streamId)
    stream.end(null)
    this.remove(streamId)
  }

  abort(streamId: number, error = 'Aborted') {
    const stream = this.get(streamId)
    stream.destroy(new Error(error))
    this.remove(streamId)
  }
}

export class ProtocolServerStreams {
  constructor(private readonly streams: Map<number, ProtocolServerStream>) {}

  get(streamId: number) {
    const stream = this.streams.get(streamId) ?? throwError('Stream not found')
    return stream
  }

  add(streamId: number, blob: ProtocolBlob) {
    const stream = new ProtocolServerStream(streamId, blob)
    this.streams.set(streamId, stream)
    return stream
  }

  remove(streamId: number) {
    this.streams.has(streamId) || throwError('Stream not found')
    this.streams.delete(streamId)
  }

  pull(streamId: number) {
    const stream = this.get(streamId)
    stream.resume()
  }

  abort(streamId: number, error = 'Aborted') {
    const stream = this.get(streamId)
    stream.destroy(new Error(error))
    this.remove(streamId)
  }
}
