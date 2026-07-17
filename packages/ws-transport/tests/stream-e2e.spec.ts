import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'

import type { ClientPlugin } from '@nmtjs/client'
import type {
  GatewayApi,
  GatewayApiCallOptions,
  GatewayResolvedProcedure,
  TransportWorker,
} from '@nmtjs/gateway'
import type { ConnectionType } from '@nmtjs/protocol'
import { RuntimeClient } from '@nmtjs/client'
import { blobType, c } from '@nmtjs/contract'
import { Container, createLogger, Hooks } from '@nmtjs/core'
import {
  Gateway,
  GatewayInjectables,
  ProxyableTransportType,
} from '@nmtjs/gateway'
import { JsonFormat as ClientJsonFormat } from '@nmtjs/json-format/client'
import { JsonFormat as ServerJsonFormat } from '@nmtjs/json-format/server'
import {
  ClientMessageType,
  getProtocolBlobStreamId,
  ProtocolVersion,
} from '@nmtjs/protocol'
import { ProtocolFormats } from '@nmtjs/protocol/server'
import { t } from '@nmtjs/type'
import { WsTransportFactory } from '@nmtjs/ws-client'
import { afterEach, describe, expect, it } from 'vitest'

import type { WsTransportRuntimeNode } from '../src/types.ts'
import { WsTransport } from '../src/runtimes/node.ts'

/**
 * End-to-end flow control suite: a real Gateway behind the real uWS transport
 * on an ephemeral loopback port, consumed by the real client stack over TCP.
 * Routing is not under test, so the API is a plain per-procedure dispatch.
 */

// mirrors the client stream layer's DEFAULT_PULL_SIZE byte-credit grant
const PULL_SIZE = 65535

const contract = c.router({
  routes: {
    download: c.procedure({ input: t.object({}), output: blobType() }),
    chunks: c.procedure({
      input: t.object({}),
      output: t.string(),
      stream: true,
    }),
    sparse: c.procedure({
      input: t.object({}),
      output: t.string(),
      stream: true,
    }),
    ticks: c.procedure({
      input: t.object({}),
      output: t.string(),
      stream: true,
    }),
    upload: c.procedure({
      input: t.object({ blob: blobType() }),
      output: t.object({ bytes: t.number(), ok: t.boolean() }),
    }),
  },
})

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

const withDeadline = async <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
) => {
  let timer!: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  try {
    return await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timer)
  }
}

const buildPattern = (size: number) => {
  const buffer = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buffer[i] = (i + (i >> 8) * 7) & 0xff
  return buffer
}

/**
 * Fixed-size-chunk source that reports how far the server has advanced into
 * the payload. hwm 1 keeps Node's own read-ahead at a single chunk so the
 * credit gate — not internal buffering — is what paces source consumption.
 */
const trackedSource = (
  pattern: Buffer,
  chunkSize: number,
  onRead: (totalBytes: number) => void,
) => {
  let offset = 0
  return new Readable({
    highWaterMark: 1,
    read() {
      if (offset >= pattern.byteLength) {
        this.push(null)
        return
      }
      const chunk = pattern.subarray(offset, offset + chunkSize)
      offset += chunk.byteLength
      onRead(offset)
      this.push(chunk)
    },
  })
}

type Handlers = Record<
  string,
  (options: GatewayApiCallOptions) => Promise<unknown>
>

const teardowns: Array<() => Promise<void>> = []

afterEach(async () => {
  while (teardowns.length) await teardowns.pop()!()
})

async function createHarness(options: {
  handlers: Handlers
  streamIdleTimeout?: number
  runtimeWs?: WsTransportRuntimeNode['ws']
  plugins?: ClientPlugin[]
}) {
  const logger = createLogger({ pinoOptions: { enabled: false } }, 'stream-e2e')
  const container = new Container({ logger })

  const api: GatewayApi = {
    resolve: async ({ procedure }) => ({ name: procedure, stream: false }),
    call: async (callOptions) => {
      const handler = options.handlers[callOptions.procedure]
      if (!handler)
        throw new Error(`Unknown procedure ${callOptions.procedure}`)
      return handler(callOptions)
    },
  }

  const transport = WsTransport.factory({
    listen: { port: 0, hostname: '127.0.0.1' },
    runtime: options.runtimeWs ? { ws: options.runtimeWs } : undefined,
  })

  const gateway = new Gateway({
    logger,
    container,
    hooks: new Hooks(),
    formats: new ProtocolFormats([new ServerJsonFormat()]),
    transports: {
      ws: {
        // variance-only cast: the WS worker never calls resolve(), which is
        // the sole member typed against ApplicationResolvedProcedure
        transport: transport as unknown as TransportWorker<
          ConnectionType,
          GatewayResolvedProcedure
        >,
        proxyable: ProxyableTransportType.WS,
      },
    },
    api,
    heartbeat: false,
    streamIdleTimeout: options.streamIdleTimeout,
  })

  // listening on port 0: the uWS listen callback reports the real bound port
  // through the returned host url
  const hosts = await gateway.start()
  const url = hosts[0].url

  const client = new RuntimeClient(
    {
      contract,
      protocol: ProtocolVersion.v1,
      format: new ClientJsonFormat(),
      plugins: options.plugins,
    },
    WsTransportFactory,
    { url },
  )

  teardowns.push(async () => {
    await client.disconnect().catch(() => {})
    client.dispose()
    await gateway.stop()
  })

  await client.connect()

  return { gateway, client }
}

describe('stream flow control over a real WS transport', () => {
  it('paces a blob download to a slow consumer and delivers it intact', async () => {
    const CHUNKS = 12
    const BLOB_SIZE = PULL_SIZE * CHUNKS
    const pattern = buildPattern(BLOB_SIZE)
    let sourceBytes = 0

    const { client } = await createHarness({
      handlers: {
        download: async ({ container }) => {
          const createBlob = await container.resolve(
            GatewayInjectables.createBlob,
          )
          return createBlob(
            trackedSource(pattern, PULL_SIZE, (total) => {
              sourceBytes = total
            }),
            { type: 'application/octet-stream', size: BLOB_SIZE },
          )
        },
      },
    })

    const blob = await client.call.download({})
    const stream = client.consumeBlob(blob)

    const received: Uint8Array[] = []
    let consumed = 0
    let maxLead = 0
    let checkedMidway = false
    for await (const chunk of stream) {
      received.push(chunk as Uint8Array)
      consumed += chunk.byteLength
      maxLead = Math.max(maxLead, sourceBytes - consumed)
      if (!checkedMidway && consumed >= BLOB_SIZE / 2) {
        checkedMidway = true
        // pacing: halfway through, the server must not have drained the source
        expect(sourceBytes).toBeLessThan(BLOB_SIZE)
      }
      await sleep(5)
    }

    const data = Buffer.concat(received)
    expect(data.byteLength).toBe(BLOB_SIZE)
    expect(data.equals(pattern)).toBe(true)
    expect(checkedMidway).toBe(true)
    // socket buffers blur exact in-flight counts: assert bounded lead only
    expect(maxLead).toBeLessThanOrEqual(5 * PULL_SIZE)
  })

  it('never lets an RPC stream producer run ahead of the consumer', async () => {
    const TOTAL = 30
    let yielded = 0
    let finished = false

    const { client } = await createHarness({
      handlers: {
        chunks: async () => () =>
          (async function* () {
            try {
              for (let i = 0; i < TOTAL; i++) {
                yielded++
                yield `chunk-${i}`
              }
            } finally {
              finished = true
            }
          })(),
      },
    })

    const stream = await client.stream.chunks({})
    const received: string[] = []
    for await (const chunk of stream) {
      received.push(chunk)
      // one chunk credit per consumer read: the generator may only ever be
      // marginally ahead of what the client has consumed
      expect(yielded).toBeLessThanOrEqual(received.length + 2)
      if (received.length % 5 === 0) await sleep(10)
    }

    expect(received).toEqual(
      Array.from({ length: TOTAL }, (_, i) => `chunk-${i}`),
    )
    expect(finished).toBe(true)
  })

  it('keeps a sparse producer alive across silences beyond the idle timeout', async () => {
    const IDLE_TIMEOUT = 300

    const { client } = await createHarness({
      streamIdleTimeout: IDLE_TIMEOUT,
      handlers: {
        sparse: async () => () =>
          (async function* () {
            yield 'first'
            // the consumer is waiting, so producer silence is not idleness
            await sleep(IDLE_TIMEOUT * 3)
            yield 'second'
          })(),
      },
    })

    const stream = await client.stream.sparse({})
    const received: string[] = []
    for await (const chunk of stream) received.push(chunk)

    expect(received).toEqual(['first', 'second'])
  })

  it('runs the server handler cleanup when the client aborts mid-stream', async () => {
    let handlerFinished!: () => void
    const handlerFinishedPromise = new Promise<void>((resolve) => {
      handlerFinished = resolve
    })

    const { client } = await createHarness({
      handlers: {
        ticks: async () => () =>
          (async function* () {
            try {
              let i = 0
              while (true) yield `tick-${i++}`
            } finally {
              handlerFinished()
            }
          })(),
      },
    })

    const controller = new AbortController()
    const stream = await client.stream.ticks({}, { signal: controller.signal })
    const iterator = stream[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: 'tick-0',
    })

    controller.abort(new Error('consumer done'))

    await expect(iterator.next()).rejects.toThrow('consumer done')
    await withDeadline(
      handlerFinishedPromise,
      5000,
      'server handler cleanup did not run after client abort',
    )
  })

  it('paces a blob upload to a slow server consumer and delivers it intact', async () => {
    const BLOB_SIZE = 8 * 65536
    const pattern = buildPattern(BLOB_SIZE)
    let pushedBytes = 0
    let serverConsumed = 0
    let maxLead = 0

    // observes outgoing pushes on the wire; sampling at push time catches the
    // widest client-ahead-of-server window
    const pacingObserver: ClientPlugin = () => ({
      onClientEvent: (event) => {
        if (
          event.kind === 'stream_event' &&
          event.direction === 'outgoing' &&
          event.streamType === 'client_blob' &&
          event.action === 'push'
        ) {
          pushedBytes += event.byteLength ?? 0
          maxLead = Math.max(maxLead, pushedBytes - serverConsumed)
        }
      },
    })

    const { client } = await createHarness({
      plugins: [pacingObserver],
      handlers: {
        upload: async ({ payload, container }) => {
          const consumeBlob = await container.resolve(
            GatewayInjectables.consumeBlob,
          )
          const stream = consumeBlob(payload.blob)
          const parts: Buffer[] = []
          for await (const chunk of stream) {
            parts.push(chunk)
            serverConsumed += chunk.byteLength
            await sleep(2)
          }
          const data = Buffer.concat(parts)
          return { bytes: data.byteLength, ok: data.equals(pattern) }
        },
      },
    })

    const blob = client.createBlob(new Blob([pattern]), {
      type: 'application/octet-stream',
    })
    const result = await client.call.upload({ blob })

    expect(result).toEqual({ bytes: BLOB_SIZE, ok: true })
    expect(pushedBytes).toBe(BLOB_SIZE)
    // pushes are gated by server-granted byte credits; allow generous slack
    // for the server-side stream buffer and frames in flight
    expect(maxLead).toBeLessThanOrEqual(4 * 65536)
  })

  it('aborts a download instead of corrupting it when uWS drops a frame', async () => {
    const BLOB_SIZE = 8 * 1024 * 1024
    const data = Buffer.alloc(BLOB_SIZE, 0xab)

    const { client } = await createHarness({
      // any buffered backpressure beyond 1KiB makes uWS drop the frame
      runtimeWs: { maxBackpressure: 1024 },
      handlers: {
        download: async ({ container }) => {
          const createBlob = await container.resolve(
            GatewayInjectables.createBlob,
          )
          // single in-memory chunk: the credit pump emits it as one 8MiB
          // frame the moment credit arrives, far beyond what the kernel
          // socket buffer absorbs synchronously
          return createBlob(Readable.from([data]), {
            type: 'application/octet-stream',
            size: BLOB_SIZE,
          })
        },
      },
    })

    const blob = await client.call.download({})
    const stream = client.consumeBlob(blob)

    // grant the whole blob in a single pull so the server sends it in one
    // synchronous burst; the client's own per-read pulls would pace it out
    const core = client.core
    const pull = core.protocol.encodeMessage(
      core.messageContext!,
      ClientMessageType.ServerStreamPull,
      { streamId: getProtocolBlobStreamId(blob), size: BLOB_SIZE },
    )
    await core.send(pull)

    // the dropped frame must surface as a stream error (transport drop abort
    // or connection close), never as truncated/corrupt data
    await expect(
      withDeadline(stream.bytes(), 10_000, 'download neither failed nor ended'),
    ).rejects.toBeDefined()
  })
})
