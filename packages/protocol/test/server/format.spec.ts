import { beforeEach, describe, expect, it } from 'vitest'

import { BaseServerFormat, ProtocolFormat } from '../../src/server/format.ts'
import { testFormat } from '../_utils.ts'

describe.sequential('Format', () => {
  let serverFormat: BaseServerFormat
  let format: ProtocolFormat

  beforeEach(() => {
    serverFormat = testFormat()
    format = new ProtocolFormat([serverFormat])
  })

  it('should be a format', () => {
    expect(format).toBeDefined()
    expect(format).toBeInstanceOf(ProtocolFormat)
  })

  it('should support a decoder', () => {
    expect(format.supportsDecoder('application/json')).toBeNull()
    expect(format.supportsDecoder('test')).toBeInstanceOf(BaseServerFormat)
  })

  it('should support a encoder', () => {
    expect(format.supportsEncoder('application/json')).toBeNull()
    expect(format.supportsEncoder('test')).toBeInstanceOf(BaseServerFormat)
  })
})
