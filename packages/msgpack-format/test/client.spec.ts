import type { DecodeRPCContext } from '@nmtjs/protocol'
import type { EncodeRPCContext } from '@nmtjs/protocol/client'
import { ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { MsgpackFormat } from '../src/client.ts'

describe('MsgpackFormat', () => {
  const format = new MsgpackFormat()

  describe('Client', () => {
    describe('encode', () => {
      it('should encode data to MessagePack Uint8Array', () => {
        const data = { foo: 'bar' }
        const buffer = format.encode(data)

        expect(buffer).toBeInstanceOf(Uint8Array)
        expect(format.decode(buffer)).toEqual(data)
      })
    })

    describe('decode', () => {
      it('should decode MessagePack buffer to data', () => {
        const data = { foo: 'bar' }
        const buffer = format.encode(data)

        expect(format.decode(buffer)).toEqual(data)
      })

      it('should decode empty buffer to undefined', () => {
        expect(format.decode(new Uint8Array(0))).toBeUndefined()
      })
    })

    describe('encodeRPC', () => {
      it('should encode RPC without streams', () => {
        const payload = { foo: 'bar' }
        const encodeCtx: EncodeRPCContext = { addStream: vi.fn() }

        const buffer = format.encodeRPC(payload, encodeCtx)

        const decodeCtx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, decodeCtx)

        expect(decoded).toEqual(payload)
        expect(decodeCtx.addStream).not.toHaveBeenCalled()
      })

      it('should encode RPC with streams', () => {
        const streamId = 0
        const metadata = { type: 'text/plain', size: 100 }
        const blob = ProtocolBlob.from(new Uint8Array([1, 2, 3]), metadata)

        const encodeCtx: EncodeRPCContext = {
          addStream: vi.fn(() => ({ id: streamId, metadata })),
        }
        const payload = { file: blob }

        const buffer = format.encodeRPC(payload, encodeCtx)

        expect(encodeCtx.addStream).toHaveBeenCalledWith(blob)

        const mockStream = { id: streamId, metadata }
        const decodeCtx = {
          addStream: vi.fn(() => mockStream),
        } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, decodeCtx)

        expect(decoded).toEqual({ file: mockStream })
        expect(decodeCtx.addStream).toHaveBeenCalledWith(streamId, metadata)
      })

      it('should encode RPC with multiple streams', () => {
        const blob1 = ProtocolBlob.from(new Uint8Array([1]), {
          type: 'text/plain',
        })
        const blob2 = ProtocolBlob.from(new Uint8Array([2]), {
          type: 'image/png',
          size: 1024,
        })

        let nextId = 0
        const encodeCtx: EncodeRPCContext = {
          addStream: vi.fn((blob: ProtocolBlob) => ({
            id: nextId++,
            metadata: blob.metadata,
          })),
        }
        const payload = { file1: blob1, file2: blob2 }

        const buffer = format.encodeRPC(payload, encodeCtx)

        expect(encodeCtx.addStream).toHaveBeenCalledTimes(2)

        const decodeCtx = {
          addStream: vi.fn((id, meta) => ({ id, metadata: meta })),
        } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, decodeCtx) as any

        expect(decoded.file1.id).toBe(0)
        expect(decoded.file1.metadata.type).toBe('text/plain')
        expect(decoded.file1.metadata.size).toBe(1)
        expect(decoded.file2.id).toBe(1)
        expect(decoded.file2.metadata.type).toBe('image/png')
        expect(decoded.file2.metadata.size).toBe(1024)
        expect(decodeCtx.addStream).toHaveBeenCalledTimes(2)
      })
    })

    describe('decodeRPC', () => {
      it('should decode RPC without streams', () => {
        const payload = { foo: 'bar', nested: { value: 123 } }
        const encodeCtx: EncodeRPCContext = { addStream: vi.fn() }
        const encoded = format.encodeRPC(payload, encodeCtx)

        const decodeCtx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(encoded, decodeCtx)

        expect(decoded).toEqual(payload)
        expect(decodeCtx.addStream).not.toHaveBeenCalled()
      })

      it('should decode RPC with streams', () => {
        const streamId = 0
        const metadata = { type: 'test', size: 100 }
        const blob = ProtocolBlob.from(new Uint8Array([1, 2, 3]), metadata)

        const encodeCtx: EncodeRPCContext = {
          addStream: vi.fn(() => ({ id: streamId, metadata })),
        }
        const payload = { foo: 'bar', stream: blob }

        const encoded = format.encodeRPC(payload, encodeCtx)

        const mockStream = { id: streamId, metadata }
        const decodeCtx = {
          addStream: vi.fn(() => mockStream),
        } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(encoded, decodeCtx)

        expect(decoded).toEqual({ foo: 'bar', stream: mockStream })
        expect(decodeCtx.addStream).toHaveBeenCalledWith(streamId, metadata)
      })
    })

    describe('undefined value handling', () => {
      it('should encode undefined data in encodeRPC', () => {
        const encodeCtx: EncodeRPCContext = { addStream: vi.fn() }

        const buffer = format.encodeRPC(undefined, encodeCtx)

        expect(buffer.byteLength).toBe(0)

        const decodeCtx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, decodeCtx)

        expect(decoded).toBeUndefined()
      })

      it('should encode null data in encodeRPC', () => {
        const encodeCtx: EncodeRPCContext = { addStream: vi.fn() }

        const buffer = format.encodeRPC(null, encodeCtx)

        const decodeCtx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, decodeCtx)

        expect(decoded).toBe(null)
      })

      it('should handle undefined values in objects', () => {
        const payload = { foo: 'bar', undef: undefined, nul: null }
        const encodeCtx: EncodeRPCContext = { addStream: vi.fn() }

        const buffer = format.encodeRPC(payload, encodeCtx)

        const decodeCtx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, decodeCtx)

        // With ignoreUndefined: true, undefined properties are omitted (like JSON)
        expect(decoded).toEqual({ foo: 'bar', nul: null })
      })

      it('should handle undefined values in arrays', () => {
        const payload = ['a', undefined, null, 'b']
        const encodeCtx: EncodeRPCContext = { addStream: vi.fn() }

        const buffer = format.encodeRPC(payload, encodeCtx)

        const decodeCtx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, decodeCtx)

        // Arrays cannot omit elements, so undefined becomes null
        expect(decoded).toEqual(['a', null, null, 'b'])
      })

      it('should round-trip 0, false, and empty string', () => {
        const payload = { zero: 0, false: false, empty: '' }
        const encodeCtx: EncodeRPCContext = { addStream: vi.fn() }

        const buffer = format.encodeRPC(payload, encodeCtx)

        const decodeCtx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, decodeCtx)

        expect(decoded).toEqual(payload)
      })

      it('should handle undefined with streams present', () => {
        const blob = ProtocolBlob.from(new Uint8Array([1, 2, 3]), {
          type: 'test',
        })
        const payload = { stream: blob, undef: undefined }

        const encodeCtx: EncodeRPCContext = {
          addStream: vi.fn(() => ({ id: 0, metadata: blob.metadata })),
        }

        const buffer = format.encodeRPC(payload, encodeCtx)

        const mockStream = { id: 0, metadata: blob.metadata }
        const decodeCtx = {
          addStream: vi.fn(() => mockStream),
        } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, decodeCtx)

        expect(decoded).toHaveProperty('stream', mockStream)
      })
    })
  })
})
