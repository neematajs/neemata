import type { EncodeRPCContext } from '@nmtjs/protocol/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { BaseClientFormat } from '@nmtjs/protocol/client'
import { describe, expect, it, vi } from 'vitest'

import { HttpTransportClient } from '../src/index.ts'

class TestFormat extends BaseClientFormat {
  contentType = 'application/x-test-format'

  encode(data: unknown): ArrayBufferView {
    return new Uint8Array([data ? 1 : 0])
  }

  encodeRPC(_data: unknown, _context: EncodeRPCContext): ArrayBufferView {
    return new Uint8Array([1])
  }

  decode(_buffer: ArrayBufferView): unknown {
    return null
  }

  decodeRPC(_buffer: ArrayBufferView, _context: any): unknown {
    return null
  }
}

describe('HttpTransportClient headers', () => {
  it('sends Accept header based on client format content type', async () => {
    const format = new TestFormat()
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }))

    const transport = new HttpTransportClient(format, ProtocolVersion.v1, {
      url: 'http://localhost:4000',
      fetch: fetchSpy,
    })

    await transport.call(
      { format },
      { callId: 1, procedure: 'ping', payload: { ok: true } },
      {},
    )

    const [, requestInit] = fetchSpy.mock.calls[0]
    const headers = requestInit?.headers as Headers

    expect(headers.get('accept')).toBe(format.contentType)
    expect(headers.get('content-type')).toBe(format.contentType)
  })
})
