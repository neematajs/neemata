import { describe, expect, it, vi } from 'vitest'

import type { ProtocolClientBlobStream } from '../../src/client/index.ts'
import { ProtocolError as ClientProtocolError } from '../../src/client/index.ts'
import { ProtocolBlob } from '../../src/common/index.ts'
import { MsgpackCodec as ClientMsgpackCodec } from '../../src/msgpack/client.ts'
import { MsgpackCodec as ServerMsgpackCodec } from '../../src/msgpack/server.ts'
import { ProtocolError as ServerProtocolError } from '../../src/server/index.ts'

describe('MsgpackCodec', () => {
  const clientCodec = new ClientMsgpackCodec()
  const serverCodec = new ServerMsgpackCodec()
  const data = { foo: 'bar', baz: 42, nested: { a: 1, b: [true, false] } }
  const createToJSONValue = () => ({
    kind: 'custom',
    original: 'value',
    toJSON: () => ({ type: 'custom-json', value: 'serialized' }),
  })

  describe('Cross compatibility', () => {
    it('should have consistent encode/decode between client and server', () => {
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
      const serverEncoded = serverCodec.encode(data)
      const clientDecoded = clientCodec.decode(serverEncoded)
      expect(clientDecoded).toEqual(data)
    })

    it('should handle top-level undefined in non-RPC encode/decode both directions', () => {
      const clientEncoded = clientCodec.encode(undefined)
      const serverDecoded = serverCodec.decode(Buffer.from(clientEncoded))
      expect(serverDecoded).toBeUndefined()

      // Server encode rejects undefined — a zero-byte frame would be
      // silently dropped over SSE and break decoding over WS
      expect(() => serverCodec.encode(undefined)).toThrow(TypeError)
      expect(() => serverCodec.encode(undefined)).toThrow(
        'Cannot encode undefined',
      )
    })

    it('should have consistent encodeRPC/decodeRPC without blobs between client and server', () => {
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
          serverCodec.encodeBlob(0, metadata),
        ),
      }

      const clientAddStreamFn = vi.fn()

      const serverEncoded = serverCodec.encodeRPC(data, { 0: metadata })

      const clientDecoded = clientCodec.decodeRPC(
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

      const clientEncoded = clientCodec.encodeRPC(data, { addStream: vi.fn() })
      const serverDecoded = serverCodec.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      // With ignoreUndefined: true, undefined properties are omitted (like JSON)
      expect(serverDecoded).toEqual({ foo: 'bar', nul: null })

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

      const clientEncoded = clientCodec.encodeRPC(data, { addStream: vi.fn() })
      const serverDecoded = serverCodec.decodeRPC(
        Buffer.from(
          clientEncoded.buffer,
          clientEncoded.byteOffset,
          clientEncoded.byteLength,
        ),
        { addStream: vi.fn() },
      )
      // Arrays cannot omit elements, so undefined becomes null
      expect(serverDecoded).toEqual(['a', null, null, 'b'])

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

    it('should preserve serialized ProtocolError shape in both directions', () => {
      const clientError = new ClientProtocolError(
        'BadRequest',
        'Client payload invalid',
        { field: 'email' },
      )
      const clientEncoded = clientCodec.encodeRPC(
        { error: clientError },
        { addStream: vi.fn() },
      )
      const serverDecoded = serverCodec.decodeRPC(Buffer.from(clientEncoded), {
        addStream: vi.fn(),
      })

      expect(serverDecoded).toEqual({ error: clientError.toJSON() })

      const serverError = new ServerProtocolError(
        'Forbidden',
        'Missing permission',
        { permission: 'write' },
      )
      const serverEncoded = serverCodec.encodeRPC({ error: serverError }, {})
      const clientDecoded = clientCodec.decodeRPC(Buffer.from(serverEncoded), {
        addStream: vi.fn(),
      })

      expect(clientDecoded).toEqual({ error: serverError.toJSON() })
    })

    it('should preserve serialized toJSON output in both directions', () => {
      const clientEncoded = clientCodec.encodeRPC(
        { meta: createToJSONValue() },
        { addStream: vi.fn() },
      )
      const serverDecoded = serverCodec.decodeRPC(Buffer.from(clientEncoded), {
        addStream: vi.fn(),
      })

      expect(serverDecoded).toEqual({
        meta: { type: 'custom-json', value: 'serialized' },
      })

      const serverEncoded = serverCodec.encodeRPC(
        { meta: createToJSONValue() },
        {},
      )
      const clientDecoded = clientCodec.decodeRPC(Buffer.from(serverEncoded), {
        addStream: vi.fn(),
      })

      expect(clientDecoded).toEqual({
        meta: { type: 'custom-json', value: 'serialized' },
      })
    })
  })
})
