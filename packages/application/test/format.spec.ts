import { BaseServerFormat } from '@nmtjs/common'
import { beforeEach, describe, expect, it } from 'vitest'
import { Format } from '../lib/format.ts'
import { testFormat } from './_utils.ts'

describe.sequential('Format', () => {
  let serverFormat: BaseServerFormat
  let format: Format

  beforeEach(() => {
    serverFormat = testFormat()
    format = new Format([serverFormat])
  })

  it('should be a format', () => {
    expect(format).toBeDefined()
    expect(format).toBeInstanceOf(Format)
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
