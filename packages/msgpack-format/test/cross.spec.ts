import type { ProtocolClientBlobStream } from '@nmtjs/protocol/client'
import { ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { MsgpackFormat as ClientMsgpackFormat } from '../src/client.ts'
import { MsgpackFormat as ServerMsgpackFormat } from '../src/server.ts'

describe('MsgpackFormat', () => {
  const clientFormat = new ClientMsgpackFormat()
  const serverFormat = new ServerMsgpackFormat()
  const data = { foo: 'bar', baz: 42, nested: { a: 1, b: [true, false] } }

  describe('Cross compatibility', () => {
    it('should have consistent encode/decode between client and server', () => {
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
      const serverEncoded = serverFormat.encode(data)
      const clientDecoded = clientFormat.decode(serverEncoded)
      expect(clientDecoded).toEqual(data)
    })

    it('should have consistent encodeRPC/decodeRPC without blobs between client and server', () => {
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
      expect(serverAddStreamFn).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ type: 'text/plain', size: 12 }),
      )
    })

    it('should have consistent encodeRPC/decodeRPC with blobs between server and client', () => {
      const metadata = { type: 'text/plain', size: 12 }
      const data = {
        foo: 'bar',
        blob: ProtocolBlob.from('Hello, test!', metadata, () =>
          serverFormat.encodeBlob(0, metadata),
        ),
      }

      const clientAddStreamFn = vi.fn()

      const serverEncoded = serverFormat.encodeRPC(data, { 0: metadata })

      const clientDecoded = clientFormat.decodeRPC(
        Buffer.from(
          serverEncoded.buffer,
          serverEncoded.byteOffset,
          serverEncoded.byteLength,
        ),
        { addStream: clientAddStreamFn },
      )

      expect(clientDecoded).toHaveProperty('foo', 'bar')
      expect(clientAddStreamFn).toHaveBeenCalledWith(0, metadata)
    })

    it('should handle undefined payloads in client → server direction', () => {
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

      const clientEncoded = clientFormat.encodeRPC(data, { addStream: vi.fn() })
      const serverDecoded = serverFormat.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      // With ignoreUndefined: true, undefined properties are omitted (like JSON)
      expect(serverDecoded).toEqual({ foo: 'bar', nul: null })

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

      const clientEncoded = clientFormat.encodeRPC(data, { addStream: vi.fn() })
      const serverDecoded = serverFormat.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      // Arrays cannot omit elements, so undefined becomes null
      expect(serverDecoded).toEqual(['a', null, null, 'b'])

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
