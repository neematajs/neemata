import { Buffer } from 'node:buffer'

import type { DecodeRPCContext, EncodeRPCContext } from '@nmtjs/protocol'
import { encodeText, ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { serializeStreamId } from '../src/common.ts'
import { JsonFormat as ServerJsonFormat } from '../src/server.ts'

const asUint8Array = (view: ArrayBufferView) =>
  view instanceof Uint8Array
    ? view
    : new Uint8Array(view.buffer, view.byteOffset, view.byteLength)

describe('Server', () => {
  const format = new ServerJsonFormat()

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
    const buffer = Buffer.from(encodeText(JSON.stringify(data)))
    expect(format.decode(buffer)).toEqual(data)
  })

  it('should encode rpc', () => {
    const blob = ProtocolBlob.from(new ArrayBuffer(1), {
      type: 'test/type',
      size: 1,
    })
    const ctx = {
      addStream: vi.fn(() => ({ id: 1, metadata: blob.metadata })),
      getStream: vi.fn(),
    } satisfies EncodeRPCContext

    const buffer = format.encodeRPC({ payload: blob }, ctx)
    const [streams, payload] = JSON.parse(
      Buffer.from(asUint8Array(buffer)).toString('utf-8'),
    )

    expect(streams).toEqual({ 1: blob.metadata })
    expect(JSON.parse(payload)).toEqual({ payload: serializeStreamId(1) })
  })

  it('should decode rpc', () => {
    const streamId = 1
    let stream: { id: number; metadata: any } | undefined

    const ctx = {
      addStream: vi.fn((id, metadata) => (stream = { id, metadata })),
      getStream: vi.fn(() => stream),
    } satisfies DecodeRPCContext

    const encoded = format.encode([
      { [streamId]: { size: 1, type: 'test', filename: 'file.txt' } },
      JSON.stringify({ foo: 'bar', stream: serializeStreamId(streamId) }),
    ])

    const payload = format.decodeRPC(encoded, ctx)

    expect(payload).toEqual({ foo: 'bar', stream })
    expect(ctx.addStream).toHaveBeenCalledWith(streamId, {
      size: 1,
      type: 'test',
      filename: 'file.txt',
    })
  })
})
