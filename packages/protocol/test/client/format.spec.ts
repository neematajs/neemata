import { deserialize, serialize } from 'node:v8'

import { describe, expect, it, vi } from 'vitest'

import type {
  DecodeRPCContext,
  EncodeRPCContext,
} from '../../src/common/types.ts'
import { BaseClientFormat } from '../../src/client/format.ts'
import { ProtocolBlob } from '../../src/common/blob.ts'

class TestClientFormat extends BaseClientFormat {
  contentType = 'test/client'

  encode(data: unknown) {
    return serialize(data) as ArrayBufferView
  }

  decode(buffer: ArrayBufferView) {
    return deserialize(Buffer.from(buffer as Uint8Array))
  }

  encodeRPC(data: unknown, context: EncodeRPCContext) {
    const streams: Record<number, any> = {}
    const streamsMeta: Record<number, any> = {}
    const payload = mapValue(data, (blob) => {
      const stream = context.addStream(blob)
      streams[stream.id] = stream
      streamsMeta[stream.id] = stream.metadata
      return { __stream: stream.id }
    })
    const buffer = this.encode({ payload, streamsMeta })
    return { buffer, streams }
  }

  decodeRPC(buffer: ArrayBufferView, context: DecodeRPCContext) {
    const { payload, streamsMeta } = this.decode(buffer) as {
      payload: unknown
      streamsMeta: Record<number, any>
    }
    return reviveValue(payload, (id: number) =>
      context.addStream(id, streamsMeta[id]),
    )
  }
}

const mapValue = (value: unknown, onBlob: (blob: ProtocolBlob) => any): any => {
  if (value instanceof ProtocolBlob) return onBlob(value)
  if (Array.isArray(value)) return value.map((item) => mapValue(item, onBlob))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        mapValue(item, onBlob),
      ]),
    )
  }
  return value
}

const reviveValue = (
  value: unknown,
  resolveStream: (id: number) => any,
): any => {
  if (Array.isArray(value))
    return value.map((item) => reviveValue(item, resolveStream))
  if (value && typeof value === 'object') {
    if ('__stream' in (value as Record<string, unknown>)) {
      return resolveStream(Number((value as { __stream: number }).__stream))
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        reviveValue(item, resolveStream),
      ]),
    )
  }
  return value
}

const createBlob = () =>
  ProtocolBlob.from(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk'))
        controller.close()
      },
    }),
    { type: 'text/plain' },
  )

describe('TestClientFormat', () => {
  it('encodes and decodes plain data', () => {
    const format = new TestClientFormat()
    const encoded = format.encode({ foo: 'bar' })
    expect(format.decode(encoded)).toEqual({ foo: 'bar' })
  })

  it('encodes RPC payloads and registers blobs as streams', () => {
    const format = new TestClientFormat()
    let streamId = 0
    const addStream = vi.fn((blob) => ({
      id: ++streamId,
      metadata: blob.metadata,
    }))
    const getStream = vi.fn((id) => ({ id }))

    const blob = createBlob()
    const result = format.encodeRPC({ file: blob, nested: [blob] }, {
      addStream,
      getStream,
    } as EncodeRPCContext)

    expect(addStream).toHaveBeenCalledTimes(2)
    expect(Object.keys(result.streams)).toHaveLength(2)
    expect(result.streams[1].metadata).toEqual(blob.metadata)
  })

  it('decodes RPC payloads and recreates server streams', () => {
    const format = new TestClientFormat()
    let streamId = 0
    const encodeContext = {
      addStream: (blob: ProtocolBlob) => ({
        id: ++streamId,
        metadata: blob.metadata,
      }),
      getStream: () => ({}),
    }
    const blob = createBlob()
    const { buffer } = format.encodeRPC({ file: blob }, encodeContext)

    const decodedStream = { id: 1, tag: 'server' }
    const decodeContext = {
      addStream: vi.fn(() => decodedStream),
      getStream: vi.fn(),
    }
    const decoded = format.decodeRPC(buffer, decodeContext as DecodeRPCContext)
    expect(decoded.file).toBe(decodedStream)
    expect(decodeContext.addStream).toHaveBeenCalledWith(1, blob.metadata)
  })
})
