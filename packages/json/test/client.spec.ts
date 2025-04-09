import {
  decodeText,
  type EncodeRPCContext,
  encodeText,
  ProtocolBlob,
} from '@nmtjs/protocol/common'
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
      namespace: 'namespace',
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
    let stream: { streamId: number; blob: ProtocolBlob } | undefined
    const ctx = {
      addStream: vi.fn((blob: ProtocolBlob) => {
        return { id: streamId, metadata: blob.metadata }
      }),
      getStream: vi.fn(() => stream),
    } satisfies EncodeRPCContext
    const buffer = format.encodeRPC(rpc, ctx)
    expect(buffer).toBeInstanceOf(ArrayBuffer)

    const [callId, namespace, procedure, streams, formatPayload] = JSON.parse(
      decodeText(buffer),
    )

    expect(callId).toBe(rpc.callId)
    expect(namespace).toBe(rpc.namespace)
    expect(procedure).toBe(rpc.procedure)
    expect(streams).toHaveProperty(
      streamId.toString(),
      rpc.payload.stream.metadata,
    )
    expect(formatPayload).toBeTypeOf('string')

    const payload = JSON.parse(formatPayload)
    expect(payload).toStrictEqual({
      foo: 'bar',
      stream: serializeStreamId(streamId),
    })
  })

  // TODO: test decoding rpc
})
