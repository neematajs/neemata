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
  readonly #source: Readable
  #piped = false

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
    this.#source = readable
    this.#source.on('error', (error) => {
      this.destroy(error)
    })

    this.id = id
    this.metadata = blob.metadata
  }

  override resume(): this {
    if (!this.#piped) {
      this.#piped = true
      this.#source.pipe(this)
    }
    return super.resume()
  }

  override destroy(error?: Error | null) {
    if (!this.#piped) {
      this.#piped = true
    }
    this.#source.destroy?.(error ?? undefined)
    return super.destroy(error ?? undefined)
  }
}
