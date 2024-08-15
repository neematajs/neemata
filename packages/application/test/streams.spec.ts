import { Readable } from 'node:stream'
import { ApiBlob } from '@nmtjs/common'
import { beforeEach, describe, expect, it } from 'vitest'
import { ServerDownStream, ServerUpStream } from '../lib/stream.ts'

describe('Server UpStream', () => {
  let stream: ServerUpStream
  const metadata = { size: 4, type: 'type', filename: 'filename' }

  beforeEach(() => {
    stream = new ServerUpStream(metadata)
  })

  it('should be defined', () => {
    expect(stream).toBeInstanceOf(Readable)
    expect(stream).toHaveProperty('metadata', metadata)
  })
})

describe('Server DownStream', () => {
  it('should be defined', () => {
    const metadata = { type: 'type', filename: 'filename' }
    const blob = ApiBlob.from('test', metadata)
    const stream = new ServerDownStream(1, blob)
    expect(stream).toHaveProperty('id', 1)
    expect(stream).toHaveProperty('blob', blob)
  })
})
