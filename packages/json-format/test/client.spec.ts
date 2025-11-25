import type {
  DecodeRPCContext,
  EncodeRPCContext,
  ProtocolBlobMetadata,
} from '@nmtjs/protocol'
import { decodeText, encodeText, ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { JsonFormat } from '../src/client.ts'
import { serializeStreamId } from '../src/common.ts'

const asUint8Array = (view: ArrayBufferView) =>
  view instanceof Uint8Array
    ? view
    : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)

describe('Client', () => {
  const format = new JsonFormat()

  it('should encode', () => {
    const data = { foo: 'bar' }
    const buffer = format.encode(data)
    expect(ArrayBuffer.isView(buffer)).toBe(true)
    expect(Array.from(asUint8Array(buffer))).toEqual(
      Array.from(encodeText(JSON.stringify(data))),
    )
  })

  it('should decode', () => {
    const data = { foo: 'bar' }
    const buffer = encodeText(JSON.stringify(data))
    expect(format.decode(buffer)).toEqual(data)
  })

  it('should encode rpc', () => {
    const streamId = 0
    const payload = {
      foo: 'bar',
      stream: ProtocolBlob.from(new ArrayBuffer(1), {
        size: 1,
        type: 'test',
        filename: 'file.txt',
      }),
    }
    let stream:
      | { id: number; metadata: ProtocolBlobMetadata; blob: ProtocolBlob }
      | undefined
    const ctx = {
      addStream: vi.fn((blob: ProtocolBlob) => {
        stream = { id: streamId, metadata: blob.metadata, blob }
        return stream
      }),
      getStream: vi.fn(() => stream),
    } satisfies EncodeRPCContext
    const { buffer, streams } = format.encodeRPC(payload, ctx)

    expect(ArrayBuffer.isView(buffer)).toBe(true)
    expect(streams[streamId]).toBe(stream)

    const [streamsMetadata, encodedPayload] = JSON.parse(decodeText(buffer))

    expect(streamsMetadata[streamId]).toMatchObject(stream!.metadata)
    expect(encodedPayload).toBeTypeOf('string')

    const result = JSON.parse(encodedPayload)
    expect(result).toStrictEqual({
      foo: 'bar',
      stream: serializeStreamId(streamId),
    })
  })

  it('should decode rpc', () => {
    const streamId = 2
    const stream = { id: streamId, type: 'test' }
    const ctx = {
      addStream: vi.fn(() => stream),
      getStream: vi.fn(() => stream),
    } satisfies DecodeRPCContext

    const encoded = format.encode([
      { [streamId]: { type: 'test' } },
      JSON.stringify({ foo: 'bar', stream: serializeStreamId(streamId) }),
    ])

    const decoded = format.decodeRPC(encoded, ctx)
    expect(decoded).toEqual({ foo: 'bar', stream })
    expect(ctx.addStream).toHaveBeenCalledWith(streamId, { type: 'test' })
  })
})
