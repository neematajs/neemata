import type { ApiBlob, ApiBlobMetadata } from '@nmtjs/common'
import type { AnyFn } from './utils.ts'

export class ClientUpStream {
  readonly reader: ReadableStreamBYOBReader

  constructor(
    readonly id: number,
    readonly blob: ApiBlob,
  ) {
    if (this.blob.source instanceof ReadableStream === false)
      throw new Error('Blob source is not a ReadableStream')
    this.reader = this.blob.source.getReader({ mode: 'byob' })
  }
}

export type ClientDownStreamBlob = {
  readonly metadata: ApiBlobMetadata
  readonly stream: ReadableStream<Uint8Array>
}

export type ClientDownStreamWrapper = {
  writer: WritableStreamDefaultWriter
  blob: ClientDownStreamBlob
}

export const createClientDownStream = (
  metadata: ApiBlobMetadata,
  pull: AnyFn,
): ClientDownStreamWrapper => {
  let bytes = 0

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
    {
      start: () => pull,
      transform(chunk, controller) {
        if (metadata.size !== -1) {
          bytes += chunk.byteLength
          if (bytes > metadata.size) {
            const error = new Error('Stream size exceeded')
            controller.error(error)
          } else {
            try {
              controller.enqueue(chunk)
            } catch (error) {
              console.error(error)
            }
          }
        } else {
          controller.enqueue(chunk)
        }
      },
    },
    { highWaterMark: 1 },
  )

  const writer = writable.getWriter()

  const blob: ClientDownStreamBlob = {
    get metadata() {
      return metadata
    },
    get stream() {
      return readable
    },
  }

  return {
    blob,
    writer,
  }
}
