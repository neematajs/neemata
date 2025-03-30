import { FormatRegistry } from '@sinclair/typebox/type'
import { describe, expect, it } from 'vitest'
import { fullFormats } from '../src/formats.ts'

import '../src/compiler.ts'

describe('Formats', () => {
  for (const name of Object.keys(fullFormats)) {
    it(`should register ${name} format`, () => {
      expect(FormatRegistry.Has(name)).toBe(true)
    })
  }
})
