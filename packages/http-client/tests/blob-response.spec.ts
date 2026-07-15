import { ProtocolVersion } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { HttpTransportFactory } from '../src/index.ts'

describe('HttpTransportClient blob responses', () => {
  const callBlob = async (headers: Record<string, string>) => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(new Uint8Array(0) as any, { status: 200, headers }),
      )

    const transport = HttpTransportFactory(
      {
        format: { contentType: 'application/json' },
        protocol: ProtocolVersion.v1,
      } as any,
      { url: 'http://localhost:4000', fetch: fetchSpy },
    )

    return await transport.call(
      { contentType: 'application/json' },
      { callId: 0, procedure: 'blob', payload: new Uint8Array(0) },
      {},
    )
  }

  it('reports size 0 for a zero-byte blob response', async () => {
    const result = await callBlob({
      'X-Neemata-Blob': 'true',
      'Content-Type': 'application/octet-stream',
      'Content-Length': '0',
    })

    expect(result).toMatchObject({
      type: 'blob',
      metadata: { type: 'application/octet-stream', size: 0 },
    })
  })

  it('reports the advertised size for a non-empty blob response', async () => {
    const result = await callBlob({
      'X-Neemata-Blob': 'true',
      'Content-Type': 'text/plain',
      'Content-Length': '42',
    })

    expect(result).toMatchObject({ type: 'blob', metadata: { size: 42 } })
  })

  it('reports unknown size when Content-Length is missing', async () => {
    const result = await callBlob({
      'X-Neemata-Blob': 'true',
      'Content-Type': 'text/plain',
    })

    expect(result.type).toBe('blob')
    expect((result as any).metadata.size).toBeUndefined()
  })
})
