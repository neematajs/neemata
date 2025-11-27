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

type TimeoutType = 'pull' | 'consume' | 'finish'

export class ProtocolServerStreams {
  protected pullTimeouts = new Map<number, any>()
  protected consumeTimeouts = new Map<number, any>()
  protected finishTimeouts = new Map<number, any>()
  protected timeoutsMap: Record<TimeoutType, Map<number, any>> = {
    pull: this.pullTimeouts,
    consume: this.consumeTimeouts,
    finish: this.finishTimeouts,
  }
  protected timeoutDuration: Record<TimeoutType, number>

  constructor(
    private readonly streams: Map<number, ProtocolServerStream>,
    protected readonly options: {
      pullTimeout?: number
      consumeTimeout?: number
      finishTimeout?: number
    },
  ) {
    this.timeoutDuration = {
      pull: 10000,
      consume: 15000,
      finish: 300000,
      ...options,
    }
  }

  get(streamId: number) {
    const stream = this.streams.get(streamId) ?? throwError('Stream not found')
    return stream
  }

  add(streamId: number, blob: ProtocolBlob) {
    const stream = new ProtocolServerStream(streamId, blob)
    this.streams.set(streamId, stream)
    this.startTimeout(streamId, 'finish')
    stream.once('finish', () => {
      this.remove(streamId)
    })
    return stream
  }

  remove(streamId: number) {
    this.streams.has(streamId) || throwError('Stream not found')
    this.streams.delete(streamId)
    this.clearTimeout(streamId, 'pull')
    this.clearTimeout(streamId, 'consume')
    this.clearTimeout(streamId, 'finish')
  }

  pull(streamId: number) {
    const stream = this.get(streamId)
    stream.resume()
    if (this.timeoutsMap.consume.has(streamId)) {
      this.clearTimeout(streamId, 'consume')
    }
    this.startTimeout(streamId, 'pull')
  }

  abort(streamId: number, error = 'Aborted') {
    const stream = this.get(streamId)
    stream.destroy(new Error(error))
    this.remove(streamId)
  }

  protected startTimeout(
    streamId: number,
    type: 'pull' | 'consume' | 'finish',
  ) {
    const timeoutMap = this.timeoutsMap[type]
    const timeoutDuration = this.timeoutDuration[type]
    this.clearTimeout(streamId, type)
    const timeout = setTimeout(() => {
      this.abort(streamId, `${type} timeout`)
      timeoutMap.delete(streamId)
    }, timeoutDuration)
    timeoutMap.set(streamId, timeout)
  }

  protected clearTimeout(
    streamId: number,
    type: 'pull' | 'consume' | 'finish',
  ) {
    const timeoutMap = this.timeoutsMap[type]
    const existingTimeout = timeoutMap.get(streamId)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
      timeoutMap.delete(streamId)
    }
  }
}
