import type { ProtocolClientBlobStream } from '@nmtjs/protocol/client'
import { ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { JsonFormat as ClientJsonFormat } from '../src/client.ts'
import { JsonFormat as ServerJsonFormat } from '../src/server.ts'

describe('JsonFormat', () => {
  const clientFormat = new ClientJsonFormat()
  const serverFormat = new ServerJsonFormat()
  const data = { foo: 'bar', baz: 42, nested: { a: 1, b: [true, false] } }

  describe('Cross compatibility', () => {
    it('should have consistent encode/decode between client and server', () => {
      // Client encodes, server decodes
      const clientEncoded = clientFormat.encode(data)
      const serverDecoded = serverFormat.decode(
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
      const serverDecoded = serverFormat.encode(data)
      const clientEncoded = clientFormat.decode(serverDecoded)
      expect(clientEncoded).toEqual(data)
    })

    it('should have consistent encodeRPC/decodeRPC without blobs between client and server', () => {
      // Client encodes, server decodes
      const clientAddStreamFn = vi.fn()
      const serverAddStreamFn = vi.fn()

      const clientEncoded = clientFormat.encodeRPC(data, {
        addStream: serverAddStreamFn,
      })
      const serverDecoded = serverFormat.decodeRPC(Buffer.from(clientEncoded), {
        addStream: clientAddStreamFn,
      })
      expect(serverDecoded).toEqual(data)
      expect(clientAddStreamFn).not.toHaveBeenCalled()
      expect(serverAddStreamFn).not.toHaveBeenCalled()
    })

    it('should have consistent encodeRPC/decodeRPC without blobs between server and client', () => {
      // Server encodes, client decodes
      const serverEncoded = serverFormat.encodeRPC(data, {})
      const spy = vi.fn()
      const clientDecoded = clientFormat.decodeRPC(Buffer.from(serverEncoded), {
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
      const clientEncoded = clientFormat.encodeRPC(data, {
        addStream: clientAddStreamFn,
      })
      const serverDecoded = serverFormat.decodeRPC(
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
          serverFormat.encodeBlob(0),
        ),
      }

      const clientAddStreamFn = vi.fn()

      // Server encodes, client decodes
      const serverEncoded = serverFormat.encodeRPC(data, {
        0: data.blob.metadata,
      })

      const clientDecoded = clientFormat.decodeRPC(
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
      const clientEncoded = clientFormat.encodeRPC(undefined, {
        addStream: vi.fn(),
      })
      const serverDecoded = serverFormat.decodeRPC(
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
      const serverEncoded = serverFormat.encodeRPC(undefined, {})
      const clientDecoded = clientFormat.decodeRPC(
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
      const clientEncoded = clientFormat.encodeRPC(null, { addStream: vi.fn() })
      const serverDecoded = serverFormat.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      expect(serverDecoded).toBe(null)

      // Server encodes null, client decodes
      const serverEncoded = serverFormat.encodeRPC(null, {})
      const clientDecoded = clientFormat.decodeRPC(
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
      const clientEncoded = clientFormat.encodeRPC(data, { addStream: vi.fn() })
      const serverDecoded = serverFormat.decodeRPC(
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
      const serverEncoded = serverFormat.encodeRPC(data, {})
      const clientDecoded = clientFormat.decodeRPC(
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
      const clientEncoded = clientFormat.encodeRPC(data, { addStream: vi.fn() })
      const serverDecoded = serverFormat.decodeRPC(
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
      const serverEncoded = serverFormat.encodeRPC(data, {})
      const clientDecoded = clientFormat.decodeRPC(
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
