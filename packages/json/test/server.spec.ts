import type { DecodeRPCContext } from '@nmtjs/protocol'
import { encodeText } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { serializeStreamId } from '../src/common.ts'
import { JsonFormat as ServerJsonFormat } from '../src/server.ts'

describe('Server', () => {
  const format = new ServerJsonFormat()

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

  it('should decode rpc', () => {
    const streamId = 1
    const input = {
      callId: 1,
      namespace: 'namespace',
      procedure: 'procedure',
      streams: { [streamId]: { size: 1, type: 'test', filename: 'file.txt' } },
      payload: JSON.stringify({
        foo: 'bar',
        stream: serializeStreamId(streamId),
      }),
    }
    let stream: { id: number; metadata: any } | undefined

    const ctx = {
      addStream: vi.fn((id, metadata) => (stream = { id, metadata })),
      getStream: vi.fn(() => stream),
    } satisfies DecodeRPCContext

    const rpc = format.decodeRPC(
      encodeText(
        JSON.stringify([
          input.callId,
          input.namespace,
          input.procedure,
          input.streams,
          input.payload,
        ]),
      ),
      ctx,
    )

    expect(rpc).toHaveProperty('callId', input.callId)
    expect(rpc).toHaveProperty('namespace', input.namespace)
    expect(rpc).toHaveProperty('procedure', input.procedure)
    expect(rpc).toHaveProperty('payload', { foo: 'bar', stream: stream! })
  })

  // TODO: test encoding rpc
})
