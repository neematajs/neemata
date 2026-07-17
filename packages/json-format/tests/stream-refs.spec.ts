import type { ProtocolClientBlobStream } from '@nmtjs/protocol/client'
import { ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { JsonFormat as ClientJsonFormat } from '../src/client.ts'
import { serializeStreamId } from '../src/common.ts'
import { JsonFormat as ServerJsonFormat } from '../src/server.ts'

const clientFormat = new ClientJsonFormat()
const serverFormat = new ServerJsonFormat()

const toServerBuffer = (view: ArrayBufferView) =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength)

// A hostile peer bypasses the format's encoder entirely, so refs arrive raw
// and unescaped — exactly what the decode gating must withstand
const craftFrame = (streams: Record<number, unknown>, payload: unknown) => {
  const streamsBuffer = Buffer.from(JSON.stringify(streams))
  const length = Buffer.alloc(4)
  length.writeUInt32LE(streamsBuffer.byteLength)
  return Buffer.concat([
    length,
    streamsBuffer,
    Buffer.from(JSON.stringify(payload)),
  ])
}

describe('stream ref injection (server decode)', () => {
  const metadata = { type: 'text/plain' }

  it('ignores refs whose id is not declared in the streams map', () => {
    const frame = craftFrame(
      { 0: metadata },
      {
        real: serializeStreamId(0),
        injected: serializeStreamId(1),
        alsoInjected: serializeStreamId(999),
      },
    )

    const stream: any = {}
    const addStream = vi.fn(() => stream)
    const decoded = serverFormat.decodeRPC(frame, { addStream }) as any

    expect(addStream).toHaveBeenCalledTimes(1)
    expect(addStream).toHaveBeenCalledWith(0, metadata)
    expect(decoded.real).toBe(stream)
    expect(decoded.injected).toBe(serializeStreamId(1))
    expect(decoded.alsoInjected).toBe(serializeStreamId(999))
  })

  it('mints stream state at most once per declared id', () => {
    const frame = craftFrame(
      { 0: metadata },
      { real: serializeStreamId(0), collision: serializeStreamId(0) },
    )

    const stream: any = {}
    const addStream = vi.fn(() => stream)
    const decoded = serverFormat.decodeRPC(frame, { addStream }) as any

    expect(addStream).toHaveBeenCalledTimes(1)
    expect(decoded.real).toBe(stream)
    expect(decoded.collision).toBe(stream)
  })

  it('ignores refs with a malformed id', () => {
    const junk = `${serializeStreamId(0)}abc`
    const frame = craftFrame({ 0: metadata }, { junk })

    const addStream = vi.fn()
    const decoded = serverFormat.decodeRPC(frame, { addStream }) as any

    expect(addStream).not.toHaveBeenCalled()
    expect(decoded.junk).toBe(junk)
  })

  it('ignores refs when no streams are declared at all', () => {
    const frame = craftFrame({}, { injected: serializeStreamId(0) })

    const addStream = vi.fn()
    const decoded = serverFormat.decodeRPC(frame, { addStream }) as any

    expect(addStream).not.toHaveBeenCalled()
    expect(decoded.injected).toBe(serializeStreamId(0))
  })
})

describe('stream ref injection (client decode)', () => {
  it('ignores refs whose id is not declared in the streams map', () => {
    const metadata = { type: 'text/plain' }
    const frame = craftFrame(
      { 0: metadata },
      { real: serializeStreamId(0), injected: serializeStreamId(7) },
    )

    const stream: any = {}
    const addStream = vi.fn(() => stream)
    const decoded = clientFormat.decodeRPC(frame, { addStream }) as any

    expect(addStream).toHaveBeenCalledTimes(1)
    expect(addStream).toHaveBeenCalledWith(0, metadata)
    expect(decoded.real).toBe(stream)
    expect(decoded.injected).toBe(serializeStreamId(7))
  })
})

describe('stream-like user data round trip', () => {
  const suspicious = {
    ref: serializeStreamId(0),
    prefixed: `${serializeStreamId(3)} not a stream`,
    nested: { deep: [serializeStreamId(42)] },
  }

  it('survives client → server without streams', () => {
    const encoded = clientFormat.encodeRPC(suspicious, { addStream: vi.fn() })
    const addStream = vi.fn()
    const decoded = serverFormat.decodeRPC(toServerBuffer(encoded), {
      addStream,
    })

    expect(decoded).toEqual(suspicious)
    expect(addStream).not.toHaveBeenCalled()
  })

  it('survives server → client without streams', () => {
    const encoded = serverFormat.encodeRPC(suspicious, {})
    const addStream = vi.fn()
    const decoded = clientFormat.decodeRPC(encoded, { addStream })

    expect(decoded).toEqual(suspicious)
    expect(addStream).not.toHaveBeenCalled()
  })

  it('survives client → server alongside a real stream with the same id', () => {
    const metadata = { type: 'text/plain' }
    const blob = ProtocolBlob.from('data', metadata)
    const payload = { blob, userData: serializeStreamId(0) }

    const clientAddStream = vi.fn(
      (b: ProtocolBlob) =>
        ({ id: 0, metadata: b.metadata }) as ProtocolClientBlobStream,
    )
    const encoded = clientFormat.encodeRPC(payload, {
      addStream: clientAddStream,
    })

    const stream: any = {}
    const serverAddStream = vi.fn(() => stream)
    const decoded = serverFormat.decodeRPC(toServerBuffer(encoded), {
      addStream: serverAddStream,
    }) as any

    expect(serverAddStream).toHaveBeenCalledTimes(1)
    expect(decoded.blob).toBe(stream)
    expect(decoded.userData).toBe(serializeStreamId(0))
  })

  it('survives server → client alongside a real stream with the same id', () => {
    const metadata = { type: 'text/plain' }
    const payload = {
      blob: ProtocolBlob.from('data', metadata, () =>
        serverFormat.encodeBlob(0),
      ),
      userData: serializeStreamId(0),
    }

    const encoded = serverFormat.encodeRPC(payload, { 0: metadata })

    const stream: any = {}
    const addStream = vi.fn(() => stream)
    const decoded = clientFormat.decodeRPC(encoded, { addStream }) as any

    expect(addStream).toHaveBeenCalledTimes(1)
    expect(decoded.blob).toBe(stream)
    expect(decoded.userData).toBe(serializeStreamId(0))
  })

  it('survives repeated escaping-sensitive round trips', () => {
    // a string that already looks escaped must not lose or gain prefixes
    const once = serverFormat.decodeRPC(
      toServerBuffer(serverFormat.encodeRPC(suspicious, {})),
      { addStream: vi.fn() },
    )
    const twice = serverFormat.decodeRPC(
      toServerBuffer(serverFormat.encodeRPC(once, {})),
      { addStream: vi.fn() },
    )
    expect(twice).toEqual(suspicious)
  })
})
