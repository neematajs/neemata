import type { EncodeRPCContext, ProtocolBlobMetadata } from '@nmtjs/protocol'
import { decodeText, encodeText, ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { JsonFormat } from '../src/client.ts'
import { serializeStreamId } from '../src/common.ts'

describe('Client', () => {
  const format = new JsonFormat()

  it('should encode', () => {
    const data = { foo: 'bar' }
    const buffer = format.encode(data)
    expect(buffer).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(buffer)).toEqual(
      new Uint8Array(encodeText(JSON.stringify(data))),
    )
  })

  it('should decode', () => {
    const data = { foo: 'bar' }
    const buffer = encodeText(JSON.stringify(data))
    expect(format.decode(buffer)).toEqual(data)
  })

  it('should encode rpc', () => {
    const streamId = 0
    const rpc = {
      callId: 1,
      procedure: 'procedure',
      payload: {
        foo: 'bar',
        stream: ProtocolBlob.from(new ArrayBuffer(1), {
          size: 1,
          type: 'test',
          filename: 'file.txt',
        }),
      },
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
    const { buffer, streams } = format.encodeRPC(rpc, ctx)

    expect(buffer).toBeInstanceOf(ArrayBuffer)
    expect(streams[streamId]).toBe(stream)

    const [callId, procedure, streamsMetadata, payload] = JSON.parse(
      decodeText(buffer),
    )

    expect(callId).toBe(rpc.callId)
    expect(procedure).toBe(rpc.procedure)
    expect(streamsMetadata[streamId]).toMatchObject(rpc.payload.stream.metadata)
    expect(payload).toBeTypeOf('string')

    const result = JSON.parse(payload)
    expect(result).toStrictEqual({
      foo: 'bar',
      stream: serializeStreamId(streamId),
    })
  })

  // TODO: test decoding rpc
})
