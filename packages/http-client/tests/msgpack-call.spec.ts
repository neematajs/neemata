import { ProtocolVersion } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { StaticClient } from '../../client/src/clients/static.ts'
import { MsgpackFormat as ClientMsgpackFormat } from '../../msgpack-format/src/client.ts'
import { MsgpackFormat as ServerMsgpackFormat } from '../../msgpack-format/src/server.ts'
import { HttpTransportFactory } from '../src/index.ts'

describe('HttpTransportClient + MsgpackFormat', () => {
  const format = new ClientMsgpackFormat()
  const serverFormat = new ServerMsgpackFormat()

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

  it('decodes server-encoded top-level undefined (empty payload) as undefined', async () => {
    const client = createClient(serverFormat.encode(undefined))

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
