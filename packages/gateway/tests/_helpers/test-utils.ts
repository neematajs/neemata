import type { LoggingOptions } from '@nmtjs/core'
import { Container, createLogger } from '@nmtjs/core'
import { BaseServerFormat } from '@nmtjs/protocol/server'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

class TestServerFormat extends BaseServerFormat {
  accept = ['application/json']
  contentType = 'application/json'

  encode(data: unknown): ArrayBufferView {
    return encoder.encode(JSON.stringify(data))
  }

  encodeRPC(data: unknown): ArrayBufferView {
    return this.encode(data)
  }

  encodeBlob(streamId: number, metadata: unknown) {
    return { streamId, metadata }
  }

  decode(buffer: ArrayBufferView) {
    return JSON.parse(decoder.decode(buffer))
  }

  decodeRPC(buffer: ArrayBufferView) {
    return this.decode(buffer)
  }
}

export function createTestLogger(
  options: LoggingOptions = { pinoOptions: { enabled: false } },
  label = 'test',
) {
  return createLogger(options, label)
}

export function createTestContainer(
  options: ConstructorParameters<typeof Container>[0] = {
    logger: createTestLogger(),
  },
) {
  return new Container(options)
}

export function createTestServerFormat() {
  return new TestServerFormat()
}
