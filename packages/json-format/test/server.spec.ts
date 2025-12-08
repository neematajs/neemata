import { Buffer } from 'node:buffer'

import type { DecodeRPCContext, EncodeRPCStreams } from '@nmtjs/protocol'
import { ProtocolBlob } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { JsonFormat } from '../src/server.ts'

describe('Server JsonFormat', () => {
  const format = new JsonFormat()

  describe('Server', () => {
    describe('encode', () => {
      it('should encode data to JSON Buffer', () => {
        const data = { foo: 'bar' }
        const buffer = format.encode(data)

        expect(Buffer.isBuffer(buffer)).toBe(true)
        expect(buffer.toString()).toBe(JSON.stringify(data))
      })

      it('should encode falsy values to empty buffer', () => {
        expect(format.encode(null).byteLength).toBe(0)
        expect(format.encode(undefined).byteLength).toBe(0)
      })
    })

    describe('decode', () => {
      it('should decode JSON buffer to data', () => {
        const data = { foo: 'bar' }
        const buffer = Buffer.from(JSON.stringify(data))

        expect(format.decode(buffer)).toEqual(data)
      })
    })

    describe('encodeRPC', () => {
      it('should encode RPC without streams', () => {
        const payload = { foo: 'bar' }
        const streams: EncodeRPCStreams = {}

        const buffer = Buffer.from(
          format.encodeRPC(payload, streams) as Uint8Array,
        )

        // Decode and verify round-trip
        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, ctx)

        expect(decoded).toEqual(payload)
        expect(ctx.addStream).not.toHaveBeenCalled()
      })

      it('should encode RPC with streams', () => {
        const streamId = 1
        const metadata = { type: 'text/plain', size: 50 }
        const payload = {
          data: ProtocolBlob.from('Hello, test!', metadata, () =>
            format.encodeBlob(streamId),
          ),
        }
        const streams: EncodeRPCStreams = { [streamId]: metadata }

        const buffer = Buffer.from(
          format.encodeRPC(payload, streams) as Uint8Array,
        )

        // Decode and verify round-trip
        const mockConsumer = vi.fn()
        const ctx = {
          addStream: vi.fn(() => mockConsumer),
        } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, ctx)

        expect(decoded).toEqual({ data: mockConsumer })
        expect(ctx.addStream).toHaveBeenCalledWith(streamId, metadata)
      })

      it('should encode RPC with multiple streams', () => {
        const metadata1 = { type: 'text/plain' }
        const metadata2 = { type: 'image/png', size: 1024 }
        const payload = {
          file1: ProtocolBlob.from('One', metadata1, () =>
            format.encodeBlob(0),
          ),
          file2: ProtocolBlob.from('Two', metadata2, () =>
            format.encodeBlob(1),
          ),
        }
        const streams: EncodeRPCStreams = { 0: metadata1, 1: metadata2 }

        const buffer = Buffer.from(
          format.encodeRPC(payload, streams) as Uint8Array,
        )

        const consumer1 = vi.fn()
        const consumer2 = vi.fn()
        const ctx = {
          addStream: vi.fn((id) => (id === 0 ? consumer1 : consumer2)),
        } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(buffer, ctx)

        expect(decoded).toEqual({ file1: consumer1, file2: consumer2 })
        expect(ctx.addStream).toHaveBeenCalledTimes(2)
        expect(ctx.addStream).toHaveBeenCalledWith(0, metadata1)
        expect(ctx.addStream).toHaveBeenCalledWith(1, metadata2)
      })
    })

    describe('decodeRPC', () => {
      it('should decode RPC without streams (fast path - no reviver)', () => {
        const payload = { foo: 'bar', nested: { value: 123 } }
        const encoded = Buffer.from(format.encodeRPC(payload, {}) as Uint8Array)

        const ctx = { addStream: vi.fn() } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(encoded, ctx)

        expect(decoded).toEqual(payload)
        expect(ctx.addStream).not.toHaveBeenCalled()
      })

      it('should decode RPC with streams (uses reviver)', () => {
        const streamId = 1
        const metadata = { type: 'test', size: 100 }
        const mockConsumer = vi.fn()

        const payload = {
          foo: 'bar',
          stream: ProtocolBlob.from('data', metadata, () =>
            format.encodeBlob(streamId),
          ),
        }
        const streams: EncodeRPCStreams = { [streamId]: metadata }

        const encoded = Buffer.from(
          format.encodeRPC(payload, streams) as Uint8Array,
        )

        const ctx = {
          addStream: vi.fn(() => mockConsumer),
        } as DecodeRPCContext<any>
        const decoded = format.decodeRPC(encoded, ctx)

        expect(decoded).toEqual({ foo: 'bar', stream: mockConsumer })
        expect(ctx.addStream).toHaveBeenCalledWith(streamId, metadata)
      })
    })
  })
})
