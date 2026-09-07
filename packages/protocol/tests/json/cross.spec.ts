import { describe, expect, it, vi } from 'vitest'

import type { ProtocolClientBlobStream } from '../../src/client/index.ts'
import { ProtocolBlob } from '../../src/common/index.ts'
import { JsonCodec as ClientJsonCodec } from '../../src/json/client.ts'
import { JsonCodec as ServerJsonCodec } from '../../src/json/server.ts'

describe('JsonCodec', () => {
  const clientCodec = new ClientJsonCodec()
  const serverCodec = new ServerJsonCodec()
  const data = { foo: 'bar', baz: 42, nested: { a: 1, b: [true, false] } }

  describe('Cross compatibility', () => {
    it('should have consistent encode/decode between client and server', () => {
      // Client encodes, server decodes
      const clientEncoded = clientCodec.encode(data)
      const serverDecoded = serverCodec.decode(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
      )
      expect(serverDecoded).toEqual(data)
    })

    it('should have consistent encode/decode between server and client', () => {
      // Client encodes, server decodes
      const serverDecoded = serverCodec.encode(data)
      const clientEncoded = clientCodec.decode(serverDecoded)
      expect(clientEncoded).toEqual(data)
    })

    it('should have consistent encodeRPC/decodeRPC without blobs between client and server', () => {
      // Client encodes, server decodes
      const clientAddStreamFn = vi.fn()
      const serverAddStreamFn = vi.fn()

      const clientEncoded = clientCodec.encodeRPC(data, {
        addStream: serverAddStreamFn,
      })
      const serverDecoded = serverCodec.decodeRPC(Buffer.from(clientEncoded), {
        addStream: clientAddStreamFn,
      })
      expect(serverDecoded).toEqual(data)
      expect(clientAddStreamFn).not.toHaveBeenCalled()
      expect(serverAddStreamFn).not.toHaveBeenCalled()
    })

    it('should have consistent encodeRPC/decodeRPC without blobs between server and client', () => {
      // Server encodes, client decodes
      const serverEncoded = serverCodec.encodeRPC(data, {})
      const spy = vi.fn()
      const clientDecoded = clientCodec.decodeRPC(Buffer.from(serverEncoded), {
        addStream: spy,
      })
      expect(clientDecoded).toEqual(data)
      expect(spy).not.toHaveBeenCalled()
    })

    it('should have consistent encodeRPC/decodeRPC with blobs between client and server', () => {
      const data = {
        foo: 'bar',
        blob: ProtocolBlob.from('Hello, test!', { type: 'text/plain' }),
      }

      const clientAddStreamFn = vi.fn(
        (blob: ProtocolBlob) =>
          ({ id: 0, metadata: blob.metadata }) as ProtocolClientBlobStream,
      )
      const serverAddStreamFn = vi.fn()

      // Client encodes, server decodes
      const clientEncoded = clientCodec.encodeRPC(data, {
        addStream: clientAddStreamFn,
      })
      const serverDecoded = serverCodec.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: serverAddStreamFn },
      )

      expect(serverDecoded).toHaveProperty('foo', 'bar')
      expect(clientAddStreamFn).toHaveBeenCalledWith(data.blob)
      expect(serverAddStreamFn).toHaveBeenCalledWith(0, data.blob.metadata)
    })

    it('should have consistent encodeRPC/decodeRPC with blobs between server and client', () => {
      const data = {
        foo: 'bar',
        blob: ProtocolBlob.from('Hello, test!', { type: 'text/plain' }, () =>
          serverCodec.encodeBlob(0),
        ),
      }

      const clientAddStreamFn = vi.fn()

      // Server encodes, client decodes
      const serverEncoded = serverCodec.encodeRPC(data, {
        0: data.blob.metadata,
      })

      const clientDecoded = clientCodec.decodeRPC(
        Buffer.from(
          serverEncoded.buffer,
          serverEncoded.byteOffset,
          serverEncoded.byteLength,
        ),
        { addStream: clientAddStreamFn },
      )

      expect(clientDecoded).toHaveProperty('foo', 'bar')
      expect(clientAddStreamFn).toHaveBeenCalledWith(0, data.blob.metadata)
    })

    it('should handle undefined payloads in client → server direction', () => {
      // Client encodes undefined, server decodes
      const clientEncoded = clientCodec.encodeRPC(undefined, {
        addStream: vi.fn(),
      })
      const serverDecoded = serverCodec.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )

      expect(serverDecoded).toBeUndefined()
    })

    it('should handle undefined payloads in server → client direction', () => {
      // Server encodes undefined, client decodes
      const serverEncoded = serverCodec.encodeRPC(undefined, {})
      const clientDecoded = clientCodec.decodeRPC(
        Buffer.from(
          serverEncoded.buffer,
          serverEncoded.byteOffset,
          serverEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )

      expect(clientDecoded).toBeUndefined()
    })

    it('should handle null payloads in both directions', () => {
      // Client encodes null, server decodes
      const clientEncoded = clientCodec.encodeRPC(null, { addStream: vi.fn() })
      const serverDecoded = serverCodec.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      expect(serverDecoded).toBe(null)

      // Server encodes null, client decodes
      const serverEncoded = serverCodec.encodeRPC(null, {})
      const clientDecoded = clientCodec.decodeRPC(
        Buffer.from(
          serverEncoded.buffer,
          serverEncoded.byteOffset,
          serverEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      expect(clientDecoded).toBe(null)
    })

    it('should handle undefined properties in objects', () => {
      const data = { foo: 'bar', undef: undefined, nul: null }

      // Client → Server
      const clientEncoded = clientCodec.encodeRPC(data, { addStream: vi.fn() })
      const serverDecoded = serverCodec.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      // JSON.stringify removes undefined properties
      expect(serverDecoded).toEqual({ foo: 'bar', nul: null })

      // Server → Client
      const serverEncoded = serverCodec.encodeRPC(data, {})
      const clientDecoded = clientCodec.decodeRPC(
        Buffer.from(
          serverEncoded.buffer,
          serverEncoded.byteOffset,
          serverEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      expect(clientDecoded).toEqual({ foo: 'bar', nul: null })
    })

    it('should handle undefined values in arrays', () => {
      const data = ['a', undefined, null, 'b']

      // Client → Server
      const clientEncoded = clientCodec.encodeRPC(data, { addStream: vi.fn() })
      const serverDecoded = serverCodec.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      // JSON.stringify converts undefined in arrays to null
      expect(serverDecoded).toEqual(['a', null, null, 'b'])

      // Server → Client
      const serverEncoded = serverCodec.encodeRPC(data, {})
      const clientDecoded = clientCodec.decodeRPC(
        Buffer.from(
          serverEncoded.buffer,
          serverEncoded.byteOffset,
          serverEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      expect(clientDecoded).toEqual(['a', null, null, 'b'])
    })
  })
})
