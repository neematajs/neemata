import { StaticClient } from '@nmtjs/client'
import { MsgpackFormat as ClientMsgpackFormat } from '@nmtjs/msgpack-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { HttpTransportFactory } from '../src/index.ts'

describe('HttpTransportClient + MsgpackFormat', () => {
  const format = new ClientMsgpackFormat()

  const createClient = (responseBody: ArrayBufferView) => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(
          new Uint8Array(
            responseBody.buffer,
            responseBody.byteOffset,
            responseBody.byteLength,
          ) as any,
          { status: 200, headers: { 'content-type': format.contentType } },
        ),
      )

    return new StaticClient(
      { contract: {} as any, protocol: ProtocolVersion.v1, format },
      HttpTransportFactory,
      { url: 'http://localhost:4000', fetch: fetchSpy },
    )
  }

  it('decodes explicit MessagePack null as null', async () => {
    const client = createClient(format.encode(null))

    await expect((client.call as any).probe(undefined)).resolves.toBe(null)
  })

  it('decodes empty payload (server void result) as undefined', async () => {
    // server responds to void results with an empty body, encode rejects undefined
    const client = createClient(new Uint8Array(0))

    await expect((client.call as any).probe(undefined)).resolves.toBeUndefined()
  })

  it('omits undefined object properties and preserves null', async () => {
    const client = createClient(format.encode({ a: 1, b: undefined, c: null }))

    await expect((client.call as any).probe(undefined)).resolves.toEqual({
      a: 1,
      c: null,
    })
  })

  it('converts undefined array entries to null', async () => {
    const client = createClient(format.encode(['x', undefined, null, 'y']))

    await expect((client.call as any).probe(undefined)).resolves.toEqual([
      'x',
      null,
      null,
      'y',
    ])
  })
})
