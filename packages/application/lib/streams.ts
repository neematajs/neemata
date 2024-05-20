import { PassThrough, Readable } from 'node:stream'
import type { ServerStreamConstructor, StreamMetadata } from '@neematajs/common'

export abstract class StreamResponse<
  Payload = any,
  Chunk = any,
> extends PassThrough {
  readonly chunk!: Chunk
  readonly payload!: Payload
}

export class EncodedStreamResponse<
  Payload = any,
  Chunk = any,
> extends StreamResponse<Payload, Chunk> {
  constructor() {
    super({ writableObjectMode: true })
  }

  write(
    chunk: Chunk,
    encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
    cb?: (error: Error | null | undefined) => void,
  ): boolean {
    if (typeof encodingOrCb === 'function') cb = encodingOrCb
    return super.write(chunk, undefined, cb)
  }

  withChunk<Chunk>() {
    return this as unknown as EncodedStreamResponse<Payload, Chunk>
  }

  withPayload<Payload>(payload: Payload) {
    // @ts-expect-error
    this.payload = payload
    return this as unknown as EncodedStreamResponse<Payload, Chunk>
  }
}

export class BinaryStreamResponse<Payload = any> extends StreamResponse<
  Payload,
  ArrayBuffer
> {
  constructor(public readonly type: string) {
    super()
  }

  withPayload<Payload>(payload: Payload) {
    // @ts-expect-error
    this.payload = payload
    return this as unknown as BinaryStreamResponse<Payload>
  }
}

export class Stream extends Readable {
  bytesReceived = 0

  constructor(
    readonly id: number,
    readonly metadata: StreamMetadata,
    read?: (size: number) => void,
    highWaterMark?: number,
  ) {
    super({ highWaterMark, read })
  }

  push(chunk: Buffer | null) {
    if (chunk !== null) this.bytesReceived += chunk.byteLength
    return super.push(chunk)
  }
}
