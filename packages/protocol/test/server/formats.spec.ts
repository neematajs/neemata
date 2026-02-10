import { beforeEach, describe, expect, it } from 'vitest'

import {
  BaseServerFormat,
  ProtocolFormats,
  parseContentTypes,
} from '../../src/server/format.ts'
import { testFormat } from '../_utils.ts'

describe.sequential('Format', () => {
  let serverFormat: BaseServerFormat
  let formats: ProtocolFormats

  beforeEach(() => {
    serverFormat = testFormat()
    formats = new ProtocolFormats([serverFormat])
  })

  it('should be a format', () => {
    expect(formats).toBeDefined()
    expect(formats).toBeInstanceOf(ProtocolFormats)
  })

  it('should support a decoder', () => {
    expect(formats.supportsDecoder('application/json')).toBeNull()
    expect(formats.supportsDecoder('test')).toBeInstanceOf(BaseServerFormat)
    expect(formats.supportsDecoder('my-test')).toBeInstanceOf(BaseServerFormat)
  })

  it('should support an encoder', () => {
    expect(formats.supportsEncoder('application/json')).toBeNull()
    expect(formats.supportsEncoder('test')).toBeInstanceOf(BaseServerFormat)
  })

  it('should throw when encoder/decoder unsupported and flag is set', () => {
    expect(() => formats.supportsDecoder('application/unknown', true)).toThrow(
      /No supported format/,
    )
    expect(() => formats.supportsEncoder('application/unknown', true)).toThrow(
      /No supported format/,
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
})
