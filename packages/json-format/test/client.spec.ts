import type { DecodeRPCContext } from '@nmtjs/protocol'
import type { EncodeRPCContext } from '@nmtjs/protocol/client'
import { ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { JsonFormat } from '../src/client.ts'

describe('JsonFormat', () => {
  const format = new JsonFormat()
  describe('Client', () => {
    describe('encode', () => {
      it('should encode data to JSON ArrayBufferView', () => {
        const data = { foo: 'bar' }
        const buffer = format.encode(data)

        expect(ArrayBuffer.isView(buffer)).toBe(true)
        expect(new TextDecoder().decode(buffer)).toBe(JSON.stringify(data))
      })
    })

    describe('decode', () => {
      it('should decode JSON buffer to data', () => {
        const data = { foo: 'bar' }
        const buffer = new TextEncoder().encode(JSON.stringify(data))

        expect(format.decode(buffer)).toEqual(data)
      })
    })

    describe('encodeRPC', () => {
      it('should encode RPC without streams', () => {
        const payload = { foo: 'bar' }
        const encodeCtx: EncodeRPCContext = { addStream: vi.fn() }

        const buffer = format.encodeRPC(payload, encodeCtx)

        // Decode and verify round-trip
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

        // Decode and verify round-trip
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
        const decoded = format.decodeRPC(buffer, decodeCtx)

        // Note: ProtocolBlob.from() auto-detects size from the source
        expect(decoded).toEqual({
          file1: { id: 0, metadata: blob1.metadata },
          file2: { id: 1, metadata: blob2.metadata },
        })
        expect(decodeCtx.addStream).toHaveBeenCalledTimes(2)
      })
    })

    describe('decodeRPC', () => {
      it('should decode RPC without streams (fast path - no reviver)', () => {
        const payload = { foo: 'bar', nested: { value: 123 } }
        const encodeCtx: EncodeRPCContext = { addStream: vi.fn() }
        const encoded = format.encodeRPC(payload, encodeCtx)

        const decodeCtx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(encoded, decodeCtx)

        expect(decoded).toEqual(payload)
        expect(decodeCtx.addStream).not.toHaveBeenCalled()
      })

      it('should decode RPC with streams (uses reviver)', () => {
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
  })
})
