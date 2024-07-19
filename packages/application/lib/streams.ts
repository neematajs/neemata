import { PassThrough, Readable } from 'node:stream'
import type { StreamMetadata } from '@neematajs/common'

export abstract class StreamResponse<
  PayloadType,
  Chunk,
  Payload = unknown,
> extends PassThrough {
  readonly _!: {
    payload: PayloadType
    chunk: Chunk
  }

  readonly type?: string
  readonly payload!: Payload

  write(
    chunk: Chunk,
    // TODO: idk wtf is this
    encodingOrCb?: BufferEncoding | ((error: Error | null | undefined) => void),
    cb?: (error: Error | null | undefined) => void,
  ): boolean {
    if (typeof encodingOrCb === 'function') cb = encodingOrCb
    return super.write(chunk, cb)
  }

  withPayload(payload: PayloadType) {
    // @ts-expect-error
    this.payload = payload
    return this as unknown as StreamResponse<PayloadType, Chunk, PayloadType>
  }
}

export class EncodedStreamResponse<Payload, Chunk> extends StreamResponse<
  Payload,
  Chunk
> {
  constructor() {
    super({
      writableObjectMode: true,
      readableObjectMode: true,
      objectMode: true,
    })
  }
}

export class BinaryStreamResponse<Payload> extends StreamResponse<
  Payload,
  string | Buffer | ArrayBuffer
> {
  constructor(public readonly type: string) {
    super()
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
