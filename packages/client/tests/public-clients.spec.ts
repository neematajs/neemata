import type { Schema, WireSchema } from '@nmtjs/common/schema'
import type { ProtocolBlobInterface } from '@nmtjs/protocol'
import { noopSchema } from '@nmtjs/common/schema'
import { c } from '@nmtjs/contract'
import { ServerMessageType } from '@nmtjs/protocol'
import { blobType, t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { ClientTransportFactory } from '../src/transport.ts'
import {
  RuntimeClient,
  RuntimeContractTransformer,
} from '../src/clients/runtime.ts'
import { StaticClient } from '../src/clients/static.ts'
import {
  createBaseOptions,
  createMockBidirectionalTransport,
  createMockUnidirectionalTransport,
  mockCodec,
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
            feed: c.stream({
              input: t.object({ limit: t.number() }),
              output: t.object({ seq: t.number() }),
            }),
          },
        }),
      },
    }),
    files: c.router({
      routes: {
        download: c.procedure({ input: t.object({}), output: blobType() }),
        downloadBundle: c.procedure({
          input: t.object({}),
          output: t.object({ audio: blobType(), transcript: t.string() }),
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
        feed: c.stream({
          input: t.object({ since: t.date() }),
          output: t.object({ id: t.bigInt(), createdAt: t.date() }),
        }),
      },
    }),
    media: c.router({
      routes: {
        transcript: c.procedure({
          input: t.object({}),
          output: t.object({ audio: blobType(), createdAt: t.date() }),
        }),
      },
    }),
  },
})

describe('public clients', () => {
  it('preserves inferred output shapes in nested static calls and streams', () => {
    const contract = c.router({
      routes: {
        nested: c.router({
          routes: {
            item: c.procedure({ output: noopSchema<{ id: number }>() }),
            feed: c.stream({
              input: t.object({ since: t.date() }),
              output: noopSchema<{ id: number }>(),
            }),
          },
        }),
      },
    })
    type Client = StaticClient<ClientTransportFactory, typeof contract>
    type Item = Client['call']['nested']['item']
    type Feed = Client['stream']['nested']['feed']
    expectTypeOf<ReturnType<Item>>().toEqualTypeOf<Promise<{ id: number }>>()
    expectTypeOf<Parameters<Item>[0]>().toEqualTypeOf<undefined>()
    expectTypeOf<Parameters<Feed>[0]>().toEqualTypeOf<{ since: string }>()
    expectTypeOf<ReturnType<Feed>>().toEqualTypeOf<
      Promise<AsyncIterable<{ id: number }>>
    >()
    expectTypeOf<keyof Client['call']['nested']>().toEqualTypeOf<'item'>()
    expectTypeOf<keyof Client['stream']['nested']>().toEqualTypeOf<'feed'>()

    const transport = createMockUnidirectionalTransport()
    expect(
      () =>
        new RuntimeClient(
          // @ts-expect-error A no-op schema still has no decoding direction for runtime clients.
          createBaseOptions({ contract }),
          transport.factory,
          {},
        ),
    ).toThrow('Runtime client procedure output must be a codec: nested/item')
  })

  it('keeps static wire types separate from runtime codec types', () => {
    type Static = StaticClient<ClientTransportFactory, typeof runtimeContract>
    type Runtime = RuntimeClient<ClientTransportFactory, typeof runtimeContract>
    type Wire = { id: string; createdAt: string }
    type Value = { id: bigint; createdAt: Date }

    expectTypeOf<
      Parameters<Static['call']['events']['create']>[0]
    >().toEqualTypeOf<Wire>()
    expectTypeOf<
      ReturnType<Static['call']['events']['create']>
    >().toEqualTypeOf<Promise<Wire>>()
    expectTypeOf<
      Parameters<Runtime['call']['events']['create']>[0]
    >().toEqualTypeOf<Value>()
    expectTypeOf<
      ReturnType<Runtime['call']['events']['create']>
    >().toEqualTypeOf<Promise<Value>>()
    expectTypeOf<
      ReturnType<Static['stream']['events']['feed']>
    >().toEqualTypeOf<Promise<AsyncIterable<Wire>>>()
    expectTypeOf<
      ReturnType<Runtime['stream']['events']['feed']>
    >().toEqualTypeOf<Promise<AsyncIterable<Value>>>()
  })

  it('requires codecs at the RuntimeClient constructor, including nested streams', () => {
    const transport = createMockUnidirectionalTransport()
    const directionalInput = c.router({
      routes: {
        invalid: c.procedure({ input: t.string().decode, output: t.string() }),
      },
    })
    expect(
      () =>
        new RuntimeClient(
          // @ts-expect-error Runtime clients must encode input through a codec.
          createBaseOptions({ contract: directionalInput }),
          transport.factory,
          {},
        ),
    ).toThrow('Runtime client procedure input must be a codec: invalid')

    const createMixedClient = (
      contract: typeof runtimeContract | typeof directionalInput,
    ) =>
      new RuntimeClient(
        // @ts-expect-error Every possible router must provide codecs, even with different route names.
        createBaseOptions({ contract }),
        transport.factory,
        {},
      )
    expect(() => createMixedClient(directionalInput)).toThrow(
      'Runtime client procedure input must be a codec: invalid',
    )
    createMixedClient(runtimeContract).dispose()

    const directionalOutput = c.router({
      routes: {
        nested: c.router({
          routes: {
            invalid: c.stream({ output: t.string().encode }),
          },
        }),
      },
    })
    expect(
      () =>
        new RuntimeClient(
          // @ts-expect-error Runtime clients must decode output through a codec at every depth.
          createBaseOptions({ contract: directionalOutput }),
          transport.factory,
          {},
        ),
    ).toThrow('Runtime client procedure output must be a codec: nested/invalid')

    const noSchemas = c.router({ routes: { empty: c.procedure({}) } })
    const client = new RuntimeClient(
      createBaseOptions({ contract: noSchemas }),
      transport.factory,
      {},
    )
    expect(typeof client.call.empty).toBe('function')
    client.dispose()
  })

  it('awaits async runtime codecs and rejects directional-only schemas', async () => {
    const schema = <Input, Output>(
      transform: (value: Input) => Promise<Output>,
    ): Schema<Input, Output> => ({
      '~standard': {
        version: 1,
        vendor: 'test',
        async validate(value) {
          return { value: await transform(value as Input) }
        },
      },
    })
    const codec: WireSchema.Codec<
      WireSchema.Decode<string, number>,
      WireSchema.Encode<number, string>
    > = {
      decode: schema(async (value: string) => Number(value)),
      encode: schema(async (value: number) => String(value)),
    }
    const contract = c.router({
      routes: { transform: c.procedure({ input: codec, output: codec }) },
    })
    const transformer = new RuntimeContractTransformer(contract)

    await expect(transformer.encode('transform', 42)).resolves.toBe('42')
    await expect(transformer.decode('transform', '42')).resolves.toBe(42)

    const directionalContract = c.router({
      routes: {
        invalid: c.procedure({ input: codec.decode, output: codec.encode }),
      },
    })
    expect(() => new RuntimeContractTransformer(directionalContract)).toThrow(
      'Runtime client procedure input must be a codec: invalid',
    )

    const directionalOutputContract = c.router({
      routes: {
        invalid: c.procedure({ input: codec, output: codec.encode }),
      },
    })
    expect(
      () => new RuntimeContractTransformer(directionalOutputContract),
    ).toThrow('Runtime client procedure output must be a codec: invalid')
  })

  it('preserves blob outputs in public client types', () => {
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
        expect(context.contentType).toBe(mockCodec.contentType)
        expect(rpc.procedure).toBe('users/profile')
        expect(mockCodec.decode(rpc.payload)).toEqual({ userId: 'u1' })
        expect(options.streamResponse).toBeUndefined()

        return {
          type: 'rpc' as const,
          result: mockCodec.encode({ ok: true, userId: 'u1' }),
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
        chunk: mockCodec.encode({ seq: 1 }),
      })
      .mockReturnValueOnce({
        type: ServerMessageType.RpcStreamChunk,
        callId: 0,
        chunk: mockCodec.encode({ seq: 2 }),
      })
      .mockReturnValueOnce({ type: ServerMessageType.RpcStreamEnd, callId: 0 })

    const streamPromise = client.stream.admin.audit.feed(
      { limit: 2 },
      { backpressure: { rpc: { window: 4 } } },
    )

    expect(encodedMessages.at(-1)).toMatchObject({
      procedure: 'admin/audit/feed',
      payload: { limit: 2 },
    })

    transport.emitMessage(new Uint8Array([1]))
    const iterable = await streamPromise

    const iterator = iterable[Symbol.asyncIterator]()

    const firstChunk = iterator.next()
    await Promise.resolve()
    expect(encodedMessages.at(-1)).toEqual({ callId: 0, size: 4 })
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
        expect(mockCodec.decode(rpc.payload)).toEqual({
          id: '42',
          createdAt: inputDate.toISOString(),
        })
        expect(options.streamResponse).toBe(false)

        return {
          type: 'rpc' as const,
          result: mockCodec.encode({ id: '99', createdAt: outputDate }),
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
        chunk: mockCodec.encode({ id: '7', createdAt: outputDate }),
      })
      .mockReturnValueOnce({ type: ServerMessageType.RpcStreamEnd, callId: 0 })

    const since = new Date('2024-03-01T00:00:00.000Z')
    const streamPromise = client.stream.events.feed({ since })
    await vi.waitFor(() => {
      expect(encodedMessages.at(-1)).toMatchObject({
        procedure: 'events/feed',
        payload: { since: since.toISOString() },
      })
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
