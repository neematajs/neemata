import type { ProtocolBlobInterface } from '@nmtjs/protocol'
import { c } from '@nmtjs/contract'
import { ServerMessageType } from '@nmtjs/protocol'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import { RuntimeClient } from '../src/clients/runtime.ts'
import { StaticClient } from '../src/clients/static.ts'
import {
  createBaseOptions,
  createMockBidirectionalTransport,
  createMockUnidirectionalTransport,
  mockFormat,
} from './_helpers/transports.ts'

const staticContract = c.router({
  routes: {
    users: c.router({
      routes: {
        profile: c.procedure({
          input: t.object({ userId: t.string() }),
          output: t.object({ ok: t.boolean(), userId: t.string() }),
        }),
      },
    }),
    admin: c.router({
      routes: {
        audit: c.router({
          routes: {
            feed: c.procedure({
              input: t.object({ limit: t.number() }),
              output: t.object({ seq: t.number() }),
              stream: true,
            }),
          },
        }),
      },
    }),
    files: c.router({
      routes: {
        download: c.procedure({ input: t.object({}), output: c.blob() }),
        downloadBundle: c.procedure({
          input: t.object({}),
          output: t.object({ audio: c.blob(), transcript: t.string() }),
        }),
      },
    }),
  },
})

const runtimeContract = c.router({
  routes: {
    events: c.router({
      routes: {
        create: c.procedure({
          input: t.object({ id: t.bigInt(), createdAt: t.date() }),
          output: t.object({ id: t.bigInt(), createdAt: t.date() }),
        }),
        feed: c.procedure({
          input: t.object({ since: t.date() }),
          output: t.object({ id: t.bigInt(), createdAt: t.date() }),
          stream: true,
        }),
      },
    }),
    media: c.router({
      routes: {
        transcript: c.procedure({
          input: t.object({}),
          output: t.object({ audio: c.blob(), createdAt: t.date() }),
        }),
      },
    }),
  },
})

describe('public clients', () => {
  it('preserves nested blob outputs in public client types', () => {
    type StaticPublicClient = StaticClient<any, typeof staticContract>
    type RuntimePublicClient = RuntimeClient<any, typeof runtimeContract>
    type StaticNestedBlobResponse = Awaited<
      ReturnType<StaticPublicClient['call']['files']['downloadBundle']>
    >
    type RuntimeNestedBlobResponse = Awaited<
      ReturnType<RuntimePublicClient['call']['media']['transcript']>
    >

    expectTypeOf<
      StaticNestedBlobResponse['audio']
    >().toEqualTypeOf<ProtocolBlobInterface>()
    expectTypeOf<
      RuntimeNestedBlobResponse['audio']
    >().toEqualTypeOf<ProtocolBlobInterface>()
  })

  it('StaticClient routes nested call procedures through the public call API', async () => {
    const { factory } = createMockUnidirectionalTransport(
      async (context, rpc, options) => {
        expect(context.contentType).toBe(mockFormat.contentType)
        expect(rpc.procedure).toBe('users/profile')
        expect(mockFormat.decode(rpc.payload)).toEqual({ userId: 'u1' })
        expect(options.streamResponse).toBeUndefined()

        return {
          type: 'rpc' as const,
          result: mockFormat.encode({ ok: true, userId: 'u1' }),
        }
      },
    )

    const client = new StaticClient(
      createBaseOptions({ contract: staticContract }),
      factory,
      {},
    )

    await expect(client.call.users.profile({ userId: 'u1' })).resolves.toEqual({
      ok: true,
      userId: 'u1',
    })
  })

  it('StaticClient exposes nested stream procedures through the public stream API', async () => {
    const transport = createMockBidirectionalTransport()
    const client = new StaticClient(
      createBaseOptions({ contract: staticContract }),
      transport.factory,
      {},
    )

    const encodedMessages: unknown[] = []
    ;(client.core.protocol as any).encodeMessage = vi.fn(
      (_context, _type, payload) => {
        encodedMessages.push(payload)
        return new Uint8Array([1])
      },
    )

    const connectPromise = client.connect()
    transport.simulateConnect()
    await connectPromise

    ;(client.core.protocol as any).decodeMessage = vi
      .fn()
      .mockReturnValueOnce({
        type: ServerMessageType.RpcStreamResponse,
        callId: 0,
      })
      .mockReturnValueOnce({
        type: ServerMessageType.RpcStreamChunk,
        callId: 0,
        chunk: mockFormat.encode({ seq: 1 }),
      })
      .mockReturnValueOnce({
        type: ServerMessageType.RpcStreamChunk,
        callId: 0,
        chunk: mockFormat.encode({ seq: 2 }),
      })
      .mockReturnValueOnce({ type: ServerMessageType.RpcStreamEnd, callId: 0 })

    const streamPromise = client.stream.admin.audit.feed({ limit: 2 })

    expect(encodedMessages.at(-1)).toMatchObject({
      procedure: 'admin/audit/feed',
      payload: { limit: 2 },
    })

    transport.emitMessage(new Uint8Array([1]))
    const iterable = await streamPromise

    const iterator = iterable[Symbol.asyncIterator]()

    const firstChunk = iterator.next()
    await Promise.resolve()
    transport.emitMessage(new Uint8Array([2]))
    await expect(firstChunk).resolves.toEqual({
      done: false,
      value: { seq: 1 },
    })

    const secondChunk = iterator.next()
    await Promise.resolve()
    transport.emitMessage(new Uint8Array([3]))
    await expect(secondChunk).resolves.toEqual({
      done: false,
      value: { seq: 2 },
    })

    const done = iterator.next()
    await Promise.resolve()
    transport.emitMessage(new Uint8Array([4]))
    await expect(done).resolves.toEqual({ done: true, value: undefined })

    client.dispose()
  })

  it('StaticClient exposes blob metadata before the blob stream is consumed', async () => {
    const metadata = { type: 'text/plain', size: 12, filename: 'hello.txt' }

    const { factory } = createMockUnidirectionalTransport(async () => ({
      type: 'blob' as const,
      metadata,
      source: new ReadableStream<ArrayBufferView>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello world!'))
          controller.close()
        },
      }),
    }))

    const client = new StaticClient(
      createBaseOptions({ contract: staticContract }),
      factory,
      {},
    )

    const blob = await client.call.files.download({})

    expect(blob).toMatchObject({ metadata })

    const blobStream = client.consumeBlob(blob)
    expect(blobStream.metadata).toEqual(metadata)
    expect(blobStream.type).toBe('text/plain')
    expect(blobStream.size).toBe(12)

    client.dispose()
  })

  it('RuntimeClient encodes inputs and decodes outputs on public call APIs', async () => {
    const inputDate = new Date('2024-01-02T03:04:05.000Z')
    const outputDate = '2024-02-03T04:05:06.000Z'

    const { factory } = createMockUnidirectionalTransport(
      async (_context, rpc, options) => {
        expect(rpc.procedure).toBe('events/create')
        expect(mockFormat.decode(rpc.payload)).toEqual({
          id: '42',
          createdAt: inputDate.toISOString(),
        })
        expect(options.streamResponse).toBe(false)

        return {
          type: 'rpc' as const,
          result: mockFormat.encode({ id: '99', createdAt: outputDate }),
        }
      },
    )

    const client = new RuntimeClient(
      createBaseOptions({ contract: runtimeContract }),
      factory,
      {},
    )

    const result = await client.call.events.create({
      id: 42n,
      createdAt: inputDate,
    })

    expect(result.id).toBe(99n)
    expect(result.createdAt).toBeInstanceOf(Date)
    expect(result.createdAt.toISOString()).toBe(outputDate)
  })

  it('RuntimeClient separates call and stream procedures on the public API', async () => {
    const transport = createMockBidirectionalTransport()
    const client = new RuntimeClient(
      createBaseOptions({ contract: runtimeContract }),
      transport.factory,
      {},
    )

    expect((client.call.events as any).feed).toBeUndefined()
    expect(typeof (client.stream.events as any).feed).toBe('function')
    expect((client.stream.events as any).create).toBeUndefined()

    const encodedMessages: unknown[] = []
    ;(client.core.protocol as any).encodeMessage = vi.fn(
      (_context, _type, payload) => {
        encodedMessages.push(payload)
        return new Uint8Array([1])
      },
    )

    const connectPromise = client.connect()
    transport.simulateConnect()
    await connectPromise

    const outputDate = '2024-03-04T05:06:07.000Z'
    ;(client.core.protocol as any).decodeMessage = vi
      .fn()
      .mockReturnValueOnce({
        type: ServerMessageType.RpcStreamResponse,
        callId: 0,
      })
      .mockReturnValueOnce({
        type: ServerMessageType.RpcStreamChunk,
        callId: 0,
        chunk: mockFormat.encode({ id: '7', createdAt: outputDate }),
      })
      .mockReturnValueOnce({ type: ServerMessageType.RpcStreamEnd, callId: 0 })

    const since = new Date('2024-03-01T00:00:00.000Z')
    const streamPromise = client.stream.events.feed({ since })

    expect(encodedMessages.at(-1)).toMatchObject({
      procedure: 'events/feed',
      payload: { since: since.toISOString() },
    })

    transport.emitMessage(new Uint8Array([1]))
    const iterable = await streamPromise

    const iterator = iterable[Symbol.asyncIterator]()
    const firstChunk = iterator.next()
    await Promise.resolve()
    transport.emitMessage(new Uint8Array([2]))
    const first = await firstChunk

    expect(first.done).toBe(false)
    expect(first.value).toMatchObject({ id: 7n })
    expect(first.value.createdAt).toBeInstanceOf(Date)
    expect(first.value.createdAt.toISOString()).toBe(outputDate)

    const done = iterator.next()
    await Promise.resolve()
    transport.emitMessage(new Uint8Array([3]))
    await expect(done).resolves.toEqual({ done: true, value: undefined })

    client.dispose()
  })
})
