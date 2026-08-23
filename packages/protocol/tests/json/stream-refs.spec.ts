import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import type { ProtocolClientBlobStream } from '../../src/client/index.ts'
import {
  createProtocolBlobReference,
  ProtocolBlob,
} from '../../src/common/index.ts'
import { JsonCodec as ClientJsonCodec } from '../../src/json/client.ts'
import { serializeStreamId } from '../../src/json/common.ts'
import { JsonCodec as ServerJsonCodec } from '../../src/json/server.ts'

const clientCodec = new ClientJsonCodec()
const serverCodec = new ServerJsonCodec()

const toServerBuffer = (view: ArrayBufferView) =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength)

// Hostile peers bypass the encoder, so refs and escape prefixes arrive raw.
const craftFrame = (streams: unknown, payload: unknown) => {
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

  it('only resolves ids declared by this frame', () => {
    const frame = craftFrame(
      { 0: metadata },
      {
        real: serializeStreamId(0),
        injected: serializeStreamId(1),
        alsoInjected: serializeStreamId(999),
      },
    )

    const stream = createProtocolBlobReference(0, metadata)
    const addStream = vi.fn(() => stream)
    const decoded = serverCodec.decodeRPC(frame, { addStream }) as any

    expect(addStream).toHaveBeenCalledTimes(1)
    expect(addStream).toHaveBeenCalledWith(0, metadata)
    expect(decoded.real).toBe(stream)
    expect(decoded.injected).toBe(serializeStreamId(1))
    expect(decoded.alsoInjected).toBe(serializeStreamId(999))
  })

  it('mints each declared stream at most once', () => {
    const frame = craftFrame(
      { 0: metadata },
      { real: serializeStreamId(0), duplicate: serializeStreamId(0) },
    )
    const stream = createProtocolBlobReference(0, metadata)
    const addStream = vi.fn(() => stream)

    const decoded = serverCodec.decodeRPC(frame, { addStream }) as any

    expect(addStream).toHaveBeenCalledTimes(1)
    expect(decoded.real).toBe(stream)
    expect(decoded.duplicate).toBe(stream)
  })

  it('leaves malformed and non-canonical Uint32 refs as strings', () => {
    const prefix = serializeStreamId(0).slice(0, -1)
    const refs = {
      trailingJunk: `${serializeStreamId(0)}abc`,
      leadingZero: `${prefix}07`,
      unsafe: `${prefix}9007199254740993`,
      overflow: `${prefix}4294967296`,
    }
    const frame = craftFrame(
      {
        0: metadata,
        7: metadata,
        9007199254740992: metadata,
        4294967296: metadata,
      },
      refs,
    )
    const addStream = vi.fn()

    expect(serverCodec.decodeRPC(frame, { addStream })).toEqual(refs)
    expect(addStream).not.toHaveBeenCalled()
  })

  it('resolves the maximum canonical Uint32 id', () => {
    const frame = craftFrame(
      { 4294967295: metadata },
      { ref: serializeStreamId(4294967295) },
    )
    const stream = createProtocolBlobReference(4294967295, metadata)
    const addStream = vi.fn(() => stream)

    const decoded = serverCodec.decodeRPC(frame, { addStream }) as any

    expect(addStream).toHaveBeenCalledWith(4294967295, metadata)
    expect(decoded.ref).toBe(stream)
  })

  it('rejects a streams section that is not a metadata record', () => {
    for (const section of ['x', [metadata], 42, true, null]) {
      const frame = craftFrame(section, { ref: serializeStreamId(0) })
      expect(() =>
        serverCodec.decodeRPC(frame, { addStream: vi.fn() }),
      ).toThrow('Malformed streams metadata section')
    }
  })

  it('does not strip a raw escape prefix from ordinary user data', () => {
    const raw = '%neemata:escape:%\fordinary'
    const frame = craftFrame({}, { raw })

    expect(serverCodec.decodeRPC(frame, { addStream: vi.fn() })).toEqual({
      raw,
    })
  })
})

describe('stream ref injection (client decode)', () => {
  const metadata = { type: 'text/plain' }

  it('only resolves ids declared by this frame and mints once', () => {
    const frame = craftFrame(
      { 0: metadata },
      {
        real: serializeStreamId(0),
        duplicate: serializeStreamId(0),
        injected: serializeStreamId(7),
      },
    )
    const stream = createProtocolBlobReference(0, metadata)
    const addStream = vi.fn(() => stream)

    const decoded = clientCodec.decodeRPC(frame, { addStream }) as any

    expect(addStream).toHaveBeenCalledTimes(1)
    expect(addStream).toHaveBeenCalledWith(0, metadata)
    expect(decoded.real).toBe(stream)
    expect(decoded.duplicate).toBe(stream)
    expect(decoded.injected).toBe(serializeStreamId(7))
  })

  it('rejects a streams section that is not a metadata record', () => {
    const frame = craftFrame('x', { ref: serializeStreamId(0) })
    expect(() => clientCodec.decodeRPC(frame, { addStream: vi.fn() })).toThrow(
      'Malformed streams metadata section',
    )
  })

  it('does not strip a raw escape prefix from ordinary user data', () => {
    const raw = '%neemata:escape:%\fordinary'
    const frame = craftFrame({}, { raw })

    expect(clientCodec.decodeRPC(frame, { addStream: vi.fn() })).toEqual({
      raw,
    })
  })
})

describe('stream-like user data round trip', () => {
  const suspicious = {
    ref: serializeStreamId(0),
    prefixed: `${serializeStreamId(3)} not a stream`,
    nested: { deep: [serializeStreamId(42)] },
    escapedOrdinary: '%neemata:escape:%\fordinary',
    escapedStream: `%neemata:escape:%\f${serializeStreamId(9)}`,
  }

  it('survives client to server and server to client without streams', () => {
    const clientEncoded = clientCodec.encodeRPC(suspicious, {
      addStream: vi.fn(),
    })
    const serverEncoded = serverCodec.encodeRPC(suspicious, {})

    expect(
      serverCodec.decodeRPC(toServerBuffer(clientEncoded), {
        addStream: vi.fn(),
      }),
    ).toEqual(suspicious)
    expect(
      clientCodec.decodeRPC(serverEncoded, { addStream: vi.fn() }),
    ).toEqual(suspicious)
  })

  it('preserves user data beside a real client stream with the same id', () => {
    const metadata = { type: 'text/plain' }
    const blob = ProtocolBlob.from('data', metadata)
    const payload = { blob, userData: serializeStreamId(0) }
    const encoded = clientCodec.encodeRPC(payload, {
      addStream: vi.fn(
        (value: ProtocolBlob) =>
          ({ id: 0, metadata: value.metadata }) as ProtocolClientBlobStream,
      ),
    })
    const stream = createProtocolBlobReference(0, metadata)
    const addStream = vi.fn(() => stream)

    const decoded = serverCodec.decodeRPC(toServerBuffer(encoded), {
      addStream,
    }) as any

    expect(addStream).toHaveBeenCalledTimes(1)
    expect(decoded.blob).toBe(stream)
    expect(decoded.userData).toBe(serializeStreamId(0))
  })

  it('preserves user data beside a real server stream with the same id', () => {
    const metadata = { type: 'text/plain' }
    const payload = {
      blob: ProtocolBlob.from('data', metadata, () =>
        serverCodec.encodeBlob(0),
      ),
      userData: serializeStreamId(0),
    }
    const encoded = serverCodec.encodeRPC(payload, { 0: metadata })
    const stream = createProtocolBlobReference(0, metadata)
    const addStream = vi.fn(() => stream)

    const decoded = clientCodec.decodeRPC(encoded, { addStream }) as any

    expect(addStream).toHaveBeenCalledTimes(1)
    expect(decoded.blob).toBe(stream)
    expect(decoded.userData).toBe(serializeStreamId(0))
  })

  it('remains stable across repeated escaping-sensitive round trips', () => {
    const once = serverCodec.decodeRPC(
      toServerBuffer(serverCodec.encodeRPC(suspicious, {})),
      { addStream: vi.fn() },
    )
    const twice = serverCodec.decodeRPC(
      toServerBuffer(serverCodec.encodeRPC(once, {})),
      { addStream: vi.fn() },
    )

    expect(twice).toEqual(suspicious)
  })
})
