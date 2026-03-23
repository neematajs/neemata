import { describe, expect, it } from 'vitest'

import { ProtocolFormats } from '../../src/server/format.ts'
import {
  getFormat,
  UnsupportedAcceptTypeError,
  UnsupportedContentTypeError,
} from '../../src/server/utils.ts'
import { testFormat } from '../_utils.ts'

describe('getFormat', () => {
  it('should resolve both encoder and decoder', () => {
    const formats = new ProtocolFormats([testFormat()])
    const { encoder, decoder } = getFormat(formats, {
      contentType: 'test',
      accept: 'test',
    })
    expect(encoder.contentType).toBe('test')
    expect(decoder.accept).toContainEqual('test')
  })

  it('should resolve encoder from accept and decoder from content-type', () => {
    const decoderFormat = testFormat()
    decoderFormat.accept = ['application/decode']
    decoderFormat.contentType = 'application/decode-response'

    const encoderFormat = testFormat()
    encoderFormat.accept = ['application/encode-request']
    encoderFormat.contentType = 'application/encode'

    const formats = new ProtocolFormats([decoderFormat, encoderFormat])
    const { encoder, decoder } = getFormat(formats, {
      contentType: 'application/decode',
      accept: 'application/encode',
    })

    expect(encoder).toBe(encoderFormat)
    expect(decoder).toBe(decoderFormat)
  })

  it('should throw when encoder unsupported', () => {
    const formats = new ProtocolFormats([testFormat()])
    expect(() =>
      getFormat(formats, { contentType: 'test', accept: 'application/json' }),
    ).toThrow(UnsupportedAcceptTypeError)
  })

  it('should throw when decoder unsupported', () => {
    const formats = new ProtocolFormats([testFormat()])
    expect(() =>
      getFormat(formats, { contentType: 'application/json', accept: 'test' }),
    ).toThrow(UnsupportedContentTypeError)
  })
})
