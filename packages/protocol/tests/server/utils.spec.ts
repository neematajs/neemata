import { describe, expect, it } from 'vitest'

import { ProtocolCodecRegistry } from '../../src/server/codec.ts'
import {
  negotiateCodecs,
  UnsupportedAcceptTypeError,
  UnsupportedContentTypeError,
} from '../../src/server/utils.ts'
import { testCodec } from '../_utils.ts'

describe('negotiateCodecs', () => {
  it('should resolve both encoder and decoder', () => {
    const codecs = new ProtocolCodecRegistry([testCodec()])
    const { encoder, decoder } = negotiateCodecs(codecs, {
      contentType: 'application/test',
      accept: 'application/test',
    })
    expect(encoder.contentType).toBe('application/test')
    expect(decoder.accept).toContainEqual('application/test')
  })

  it('should resolve encoder from accept and decoder from content-type', () => {
    const decoderCodec = testCodec()
    decoderCodec.accept = ['application/decode']
    decoderCodec.contentType = 'application/decode-response'

    const encoderCodec = testCodec()
    encoderCodec.accept = ['application/encode-request']
    encoderCodec.contentType = 'application/encode'

    const codecs = new ProtocolCodecRegistry([decoderCodec, encoderCodec])
    const { encoder, decoder } = negotiateCodecs(codecs, {
      contentType: 'application/decode',
      accept: 'application/encode',
    })

    expect(encoder).toBe(encoderCodec)
    expect(decoder).toBe(decoderCodec)
  })

  it('should throw when encoder unsupported', () => {
    const codecs = new ProtocolCodecRegistry([testCodec()])
    expect(() =>
      negotiateCodecs(codecs, {
        contentType: 'application/test',
        accept: 'application/json',
      }),
    ).toThrow(UnsupportedAcceptTypeError)
  })

  it('should throw when decoder unsupported', () => {
    const codecs = new ProtocolCodecRegistry([testCodec()])
    expect(() =>
      negotiateCodecs(codecs, {
        contentType: 'application/json',
        accept: 'application/test',
      }),
    ).toThrow(UnsupportedContentTypeError)
  })
})
