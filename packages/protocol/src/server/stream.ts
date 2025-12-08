import type { ReadableOptions } from 'node:stream'
import { PassThrough, Readable } from 'node:stream'
import { ReadableStream } from 'node:stream/web'

import type { ProtocolBlob, ProtocolBlobMetadata } from '../common/blob.ts'

export class ProtocolClientStream extends PassThrough {
  readonly #read?: ReadableOptions['read']

  constructor(
    public readonly id: number,
    public readonly metadata: ProtocolBlobMetadata,
    options?: ReadableOptions,
  ) {
    const { read, ...rest } = options ?? {}
    super(rest)
    this.#read = read
  }

  override _read(size: number): void {
    if (this.#read) {
      this.#read.call(this, size)
    }
    super._read(size)
  }
}

export class ProtocolServerStream extends PassThrough {
  public readonly id: number
  public readonly metadata: ProtocolBlobMetadata

  constructor(id: number, blob: ProtocolBlob) {
    let readable: Readable

    if (blob.source instanceof Readable) {
      readable = blob.source
    } else if (blob.source instanceof ReadableStream) {
      readable = Readable.fromWeb(blob.source as ReadableStream)
    } else {
      throw new Error('Invalid source type')
    }

    super()

    this.pause()
    readable.pipe(this)

    this.id = id
    this.metadata = blob.metadata
  }
}
