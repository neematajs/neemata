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

  it('should throw when encoder unsupported', () => {
    const formats = new ProtocolFormats([testFormat()])
    expect(() =>
      getFormat(formats, { contentType: 'application/json', accept: 'test' }),
    ).toThrow(UnsupportedContentTypeError)
  })

  it('should throw when decoder unsupported', () => {
    const formats = new ProtocolFormats([testFormat()])
    expect(() =>
      getFormat(formats, { contentType: 'test', accept: 'application/json' }),
    ).toThrow(UnsupportedAcceptTypeError)
  })
})
