import { beforeEach, describe, expect, it } from 'vitest'
import { Format } from '../lib/format'
import { testFormat } from './_utils'

describe.sequential('Format', () => {
  let format: Format

  beforeEach(() => {
    format = new Format([testFormat()])
  })

  it('should be a format', () => {
    expect(format).toBeDefined()
    expect(format).toBeInstanceOf(Format)
  })
})
