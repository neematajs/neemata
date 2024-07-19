import { Duplex, Readable } from 'node:stream'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BinaryStreamResponse,
  EncodedStreamResponse,
  Stream,
} from '../lib/streams'
import { noop } from '../lib/utils/functions'

describe.sequential('Streams -> Response -> Encoded', () => {
  it('should be a duplex', () => {
    expect(new EncodedStreamResponse()).toBeInstanceOf(Duplex)
  })

  it('should assign paylaod', () => {
    const payload = { test: true }
    const stream = new EncodedStreamResponse().withPayload(payload)
    expect(stream.payload).toBe(payload)
  })

  it('should write an in object-mode', async () => {
    const stream = new EncodedStreamResponse()
    const payload = { test: true }
    setTimeout(() => stream.write(payload), 1)
    const expectation = new Promise((r) => stream.on('data', r))
    await expect(expectation).resolves.toEqual(payload)
  })
})

describe.sequential('Streams -> Response -> Binary', () => {
  it('should be a duplex', () => {
    expect(new BinaryStreamResponse('type')).toBeInstanceOf(Duplex)
  })

  it('should assign paylaod', () => {
    const payload = 'test'
    const stream = new BinaryStreamResponse('type').withPayload(payload)
    expect(stream.payload).toBe(payload)
  })

  it('should write', async () => {
    const stream = new BinaryStreamResponse('type')
    const payload = 'test'
    setTimeout(() => stream.write(payload), 1)
    const expectation = new Promise((r) => stream.on('data', r))
    await expect(expectation).resolves.toEqual(Buffer.from(payload))
  })
})

describe.sequential('Streams -> Request -> Stream', () => {
  let stream: Stream

  beforeEach(() => {
    stream = new Stream(
      1,
      { size: 1, type: 'type', filename: 'filename' },
      noop,
    )
  })

  it('should be a readable', () => {
    expect(stream).toBeInstanceOf(Readable)
  })

  it('should have properties', () => {
    expect(stream).toHaveProperty('id', 1)
    expect(stream).toHaveProperty('metadata', {
      size: 1,
      type: 'type',
      filename: 'filename',
    })
  })

  it('should count bytes', () => {
    const buffer = Buffer.from('test')
    stream.push(buffer)
    expect(stream.bytesReceived).toBe(buffer.byteLength)
  })
})
