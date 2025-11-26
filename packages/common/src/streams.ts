// TODO: add proper queueing/backpressure strategy support

export interface DuplexStreamSink<O = unknown, I = O> {
  start?: () => void
  pull?: (size: number | null) => void
  transform?: (chunk: I) => O
}

export class DuplexStream<O = unknown, I = O> {
  readonly readable: ReadableStream<O>
  readonly writable!: WritableStream<I>

  constructor(sink: DuplexStreamSink<O, I> = {}) {
    this.readable = new ReadableStream<O>({
      start: (controller) => {
        // @ts-expect-error
        this.writable = new WritableStream<I>({
          write: (_chunk) => {
            const chunk = sink?.transform ? sink?.transform(_chunk) : _chunk
            controller.enqueue(chunk as O)
          },
          abort: (reason) => controller.error(reason),
          close: () => controller.close(),
        })
        sink.start?.()
      },
      pull: sink?.pull
        ? (controller) => {
            sink?.pull?.(controller.desiredSize)
          }
        : undefined,
    })
  }

  push(chunk: I) {
    const writer = this.writable.getWriter()
    writer.write(chunk)
    writer.releaseLock()
  }

  end() {
    const writer = this.writable.getWriter()
    writer.close()
    writer.releaseLock()
  }

  abort(error = new Error('Stream aborted')) {
    const writer = this.writable.getWriter()
    writer.abort(error)
    writer.releaseLock()
  }
}
