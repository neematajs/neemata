import { beforeEach, describe, expect, it } from 'vitest'

import {
  BaseServerCodec,
  ProtocolCodecRegistry,
  parseContentTypes,
} from '../../src/server/codec.ts'
import { testCodec } from '../_utils.ts'

describe.sequential('Codec', () => {
  let serverCodec: BaseServerCodec
  let codecs: ProtocolCodecRegistry

  beforeEach(() => {
    serverCodec = testCodec()
    codecs = new ProtocolCodecRegistry([serverCodec])
  })

  it('should be a codec', () => {
    expect(codecs).toBeDefined()
    expect(codecs).toBeInstanceOf(ProtocolCodecRegistry)
  })

  it('should support a decoder', () => {
    expect(codecs.supportsDecoder('application/json')).toBeNull()
    expect(codecs.supportsDecoder('application/test')).toBeInstanceOf(
      BaseServerCodec,
    )
    expect(codecs.supportsDecoder('application/my-test')).toBeInstanceOf(
      BaseServerCodec,
    )
  })

  it('should support an encoder', () => {
    expect(codecs.supportsEncoder('application/json')).toBeNull()
    expect(codecs.supportsEncoder('application/test')).toBeInstanceOf(
      BaseServerCodec,
    )
  })

  it('should throw when encoder/decoder unsupported and flag is set', () => {
    expect(() => codecs.supportsDecoder('application/unknown', true)).toThrow(
      /No supported codec/,
    )
    expect(() => codecs.supportsEncoder('application/unknown', true)).toThrow(
      /No supported codec/,
    )
  })
})

describe('parseContentTypes', () => {
  it('should split, sort, and keep wildcards last', () => {
    expect(
      parseContentTypes('application/json;q=0.2, text/plain, */*;q=0.1'),
    ).toEqual(['text/plain', 'application/json', '*/*'])
  })

  it('should return wildcard when explicitly requested', () => {
    expect(parseContentTypes('*/*')).toEqual(['*/*'])
  })

  it('parses quoted MIME parameters without treating delimiters as syntax', () => {
    expect(
      parseContentTypes(
        'application/json; profile="https://example.com/a;b=c"; q=0.5',
      ),
    ).toEqual(['application/json'])
  })

  it('rejects values that are not valid MIME types', () => {
    expect(() => parseContentTypes('test')).toThrow(TypeError)
  })
})
