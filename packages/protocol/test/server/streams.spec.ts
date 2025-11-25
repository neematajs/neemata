import { once } from 'node:events'
import { Readable } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { ProtocolBlob } from '../../src/common/blob.ts'
import {
  ProtocolClientStreams,
  ProtocolServerStreams,
} from '../../src/server/streams.ts'

describe('ProtocolClientStreams', () => {
  it('should push and end data flow', async () => {
    const registry = new Map<number, any>()
    const streams = new ProtocolClientStreams(registry)
    const stream = streams.add(1, { type: 'text/plain' }, vi.fn())

    const chunkPromise = once(stream, 'data')
    streams.push(1, Buffer.from('payload'))
    const [chunk] = await chunkPromise
    expect(Buffer.from(chunk).toString()).toBe('payload')

    const endPromise = once(stream, 'end')
    streams.end(1)
    await endPromise
    expect(registry.size).toBe(0)
  })

  it('should abort stream with error', async () => {
    const registry = new Map<number, any>()
    const streams = new ProtocolClientStreams(registry)
    const stream = streams.add(10, { type: 'text/plain' }, vi.fn())

    const errorPromise = once(stream, 'error')
    streams.abort(10, 'Boom')
    const [error] = await errorPromise
    expect(error).toBeInstanceOf(Error)
    expect(error.message).toBe('Boom')
    expect(registry.size).toBe(0)
  })

  it('should throw when operating on missing stream', () => {
    const streams = new ProtocolClientStreams(new Map())
    expect(() => streams.push(999, Buffer.alloc(0))).toThrow('Stream not found')
    expect(() => streams.end(999)).toThrow('Stream not found')
    expect(() => streams.abort(999)).toThrow('Stream not found')
  })
})

describe('ProtocolServerStreams', () => {
  it('should pull data from blob backed stream', async () => {
    const registry = new Map<number, any>()
    const streams = new ProtocolServerStreams(registry)
    const blob = ProtocolBlob.from(Readable.from(['chunk']))
    const stream = streams.add(7, blob)

    const chunkPromise = once(stream, 'data')
    streams.pull(7)
    const [chunk] = await chunkPromise
    expect(Buffer.from(chunk).toString()).toBe('chunk')
  })

  it('should abort and remove server stream', async () => {
    const registry = new Map<number, any>()
    const streams = new ProtocolServerStreams(registry)
    const blob = ProtocolBlob.from(Readable.from(['chunk']))
    const stream = streams.add(11, blob)

    const errorPromise = once(stream, 'error')
    streams.abort(11, 'Stop')
    const [error] = await errorPromise
    expect(error.message).toBe('Stop')
    expect(registry.size).toBe(0)
  })

  it('should throw when accessing missing stream', () => {
    const streams = new ProtocolServerStreams(new Map())
    expect(() => streams.get(101)).toThrow('Stream not found')
    expect(() => streams.remove(101)).toThrow('Stream not found')
  })
})
