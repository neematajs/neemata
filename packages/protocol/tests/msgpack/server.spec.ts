import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import type {
  DecodeRPCContext,
  EncodeRPCStreams,
} from '../../src/common/index.ts'
import { ProtocolBlob } from '../../src/common/index.ts'
import { MsgpackCodec } from '../../src/msgpack/server.ts'
import { ProtocolError } from '../../src/server/index.ts'

describe('Server MsgpackCodec', () => {
  const codec = new MsgpackCodec()
  const createToJSONValue = () => ({
    kind: 'custom',
    original: 'value',
    toJSON: () => ({ type: 'custom-json', value: 'serialized' }),
  })

  describe('Server', () => {
    describe('encode', () => {
      it('should encode data to MessagePack Buffer', () => {
        const data = { foo: 'bar' }
        const buffer = codec.encode(data)

        expect(Buffer.isBuffer(buffer)).toBe(true)
        expect(codec.decode(buffer)).toEqual(data)
      })

      it('should reject undefined', () => {
        expect(() => codec.encode(undefined)).toThrow(TypeError)
        expect(() => codec.encode(undefined)).toThrow('Cannot encode undefined')
      })
    })

    describe('decode', () => {
      it('should decode MessagePack buffer to data', () => {
        const data = { foo: 'bar' }
        const buffer = codec.encode(data)

        expect(codec.decode(buffer)).toEqual(data)
      })

      it('should decode empty buffer to undefined', () => {
        expect(codec.decode(Buffer.alloc(0))).toBeUndefined()
      })

      it('should encode and decode objects with toJSON using serialized output', () => {
        const value = createToJSONValue()

        const buffer = codec.encode(value)

        expect(codec.decode(buffer)).toEqual({
          type: 'custom-json',
          value: 'serialized',
        })
      })

      it('should encode and decode plain Error instances as objects', () => {
        const error = new Error('boom')

        const buffer = codec.encode(error)

        expect(codec.decode(buffer)).toEqual({
          name: 'Error',
          message: 'boom',
        })
      })

      it('should encode and decode ProtocolError using toJSON', () => {
        const error = new ProtocolError('BadRequest', 'Invalid payload', {
          field: 'name',
        })

        const buffer = codec.encode(error)

        expect(codec.decode(buffer)).toEqual(error.toJSON())
      })
    })

    describe('encodeRPC', () => {
      it('should encode RPC without streams', () => {
        const payload = { foo: 'bar' }
        const streams: EncodeRPCStreams = {}

        const buffer = Buffer.from(
          codec.encodeRPC(payload, streams) as Uint8Array,
        )

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        expect(decoded).toEqual(payload)
        expect(ctx.addStream).not.toHaveBeenCalled()
      })

      it('should encode RPC with streams', () => {
        const streamId = 1
        const metadata = { type: 'text/plain', size: 50 }
        const payload = {
          data: ProtocolBlob.from('Hello, test!', metadata, () =>
            codec.encodeBlob(streamId, metadata),
          ),
        }
        const streams: EncodeRPCStreams = { [streamId]: metadata }

        const buffer = Buffer.from(
          codec.encodeRPC(payload, streams) as Uint8Array,
        )

        const mockConsumer = vi.fn()
        const ctx = {
          addStream: vi.fn(() => mockConsumer),
        } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        expect(decoded).toEqual({ data: mockConsumer })
        expect(ctx.addStream).toHaveBeenCalledWith(streamId, metadata)
      })

      it('should encode RPC with a zero-byte stream', () => {
        const streamId = 1
        const metadata = { type: 'text/plain', size: 0 }
        const payload = {
          data: ProtocolBlob.from('', metadata, () =>
            codec.encodeBlob(streamId, metadata),
          ),
        }
        const streams: EncodeRPCStreams = { [streamId]: metadata }

        const buffer = Buffer.from(
          codec.encodeRPC(payload, streams) as Uint8Array,
        )

        const mockConsumer = vi.fn()
        const ctx = {
          addStream: vi.fn(() => mockConsumer),
        } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        expect(decoded).toEqual({ data: mockConsumer })
        expect(ctx.addStream).toHaveBeenCalledWith(streamId, metadata)
      })

      it('should encode RPC with multiple streams', () => {
        const metadata1 = { type: 'text/plain' }
        const metadata2 = { type: 'image/png', size: 1024 }
        const payload = {
          file1: ProtocolBlob.from('One', metadata1, () =>
            codec.encodeBlob(0, metadata1),
          ),
          file2: ProtocolBlob.from('Two', metadata2, () =>
            codec.encodeBlob(1, metadata2),
          ),
        }
        const streams: EncodeRPCStreams = { 0: metadata1, 1: metadata2 }

        const buffer = Buffer.from(
          codec.encodeRPC(payload, streams) as Uint8Array,
        )

        const consumer1 = vi.fn()
        const consumer2 = vi.fn()
        const ctx = {
          addStream: vi.fn((id) => (id === 0 ? consumer1 : consumer2)),
        } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        expect(decoded).toEqual({ file1: consumer1, file2: consumer2 })
        expect(ctx.addStream).toHaveBeenCalledTimes(2)
        expect(ctx.addStream).toHaveBeenCalledWith(0, metadata1)
        expect(ctx.addStream).toHaveBeenCalledWith(1, metadata2)
      })
    })

    describe('decodeRPC', () => {
      it('should decode RPC without streams', () => {
        const payload = { foo: 'bar', nested: { value: 123 } }
        const encoded = Buffer.from(codec.encodeRPC(payload, {}) as Uint8Array)

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(encoded, ctx)

        expect(decoded).toEqual(payload)
        expect(ctx.addStream).not.toHaveBeenCalled()
      })

      it('should decode RPC with streams', () => {
        const streamId = 1
        const metadata = { type: 'test', size: 100 }
        const mockConsumer = vi.fn()

        const payload = {
          foo: 'bar',
          stream: ProtocolBlob.from('data', metadata, () =>
            codec.encodeBlob(streamId, metadata),
          ),
        }
        const streams: EncodeRPCStreams = { [streamId]: metadata }

        const encoded = Buffer.from(
          codec.encodeRPC(payload, streams) as Uint8Array,
        )

        const ctx = {
          addStream: vi.fn(() => mockConsumer),
        } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(encoded, ctx)

        expect(decoded).toEqual({ foo: 'bar', stream: mockConsumer })
        expect(ctx.addStream).toHaveBeenCalledWith(streamId, metadata)
      })

      it('should encode and decode nested toJSON values in RPC payloads', () => {
        const payload = { ok: true, meta: createToJSONValue() }

        const encoded = Buffer.from(codec.encodeRPC(payload, {}) as Uint8Array)

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(encoded, ctx)

        expect(decoded).toEqual({
          ok: true,
          meta: { type: 'custom-json', value: 'serialized' },
        })
      })

      it('should encode and decode nested ProtocolError values in RPC payloads', () => {
        const error = new ProtocolError('Forbidden', 'Access denied', {
          role: 'guest',
        })
        const payload = { ok: false, error }

        const encoded = Buffer.from(codec.encodeRPC(payload, {}) as Uint8Array)

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(encoded, ctx)

        expect(decoded).toEqual({ ok: false, error: error.toJSON() })
      })
    })

    describe('undefined value handling', () => {
      it('should reject undefined in encode', () => {
        expect(() => codec.encode(undefined)).toThrow(TypeError)
        expect(() => codec.encode(undefined)).toThrow('Cannot encode undefined')
      })

      it('should encode null as MessagePack nil', () => {
        const buffer = codec.encode(null)
        expect(codec.decode(buffer)).toBe(null)
      })

      it('should encode undefined data in encodeRPC', () => {
        const streams: EncodeRPCStreams = {}

        const buffer = Buffer.from(
          codec.encodeRPC(undefined, streams) as Uint8Array,
        )

        expect(buffer.byteLength).toBe(0)

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        expect(decoded).toBeUndefined()
      })

      it('should encode null data in encodeRPC', () => {
        const streams: EncodeRPCStreams = {}

        const buffer = Buffer.from(codec.encodeRPC(null, streams) as Uint8Array)

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        expect(decoded).toBe(null)
      })

      it('should handle undefined values in objects', () => {
        const payload = { foo: 'bar', undef: undefined, nul: null }
        const streams: EncodeRPCStreams = {}

        const buffer = Buffer.from(
          codec.encodeRPC(payload, streams) as Uint8Array,
        )

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        // With ignoreUndefined: true, undefined properties are omitted (like JSON)
        expect(decoded).toEqual({ foo: 'bar', nul: null })
      })

      it('should handle undefined values in arrays', () => {
        const payload = ['a', undefined, null, 'b']
        const streams: EncodeRPCStreams = {}

        const buffer = Buffer.from(
          codec.encodeRPC(payload, streams) as Uint8Array,
        )

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        // Arrays cannot omit elements, so undefined becomes null
        expect(decoded).toEqual(['a', null, null, 'b'])
      })

      it('should round-trip 0, false, and empty string', () => {
        const payload = { zero: 0, false: false, empty: '' }
        const streams: EncodeRPCStreams = {}

        const buffer = Buffer.from(
          codec.encodeRPC(payload, streams) as Uint8Array,
        )

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        expect(decoded).toEqual(payload)
      })

      it('should handle undefined with streams present', () => {
        const streamId = 1
        const metadata = { type: 'test' }
        const payload = {
          stream: ProtocolBlob.from('data', metadata, () =>
            codec.encodeBlob(streamId, metadata),
          ),
          undef: undefined,
        }
        const streams: EncodeRPCStreams = { [streamId]: metadata }

        const buffer = Buffer.from(
          codec.encodeRPC(payload, streams) as Uint8Array,
        )

        const mockConsumer = vi.fn()
        const ctx = {
          addStream: vi.fn(() => mockConsumer),
        } as DecodeRPCContext<any>
        const decoded = codec.decodeRPC(buffer, ctx)

        expect(decoded).toHaveProperty('stream', mockConsumer)
      })
    })
  })
})
