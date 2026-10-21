import { describe, expect, it } from 'vitest'

import { sourceMapsFlag } from '../../src/internal/source-maps.ts'

describe('source-map flag', () => {
  it('is undefined without a flag', () => {
    expect(sourceMapsFlag(['--expose-gc'], '--max-old-space-size=512')).toBe(
      undefined,
    )
    expect(sourceMapsFlag([], undefined)).toBe(undefined)
  })

  it('takes the last flag, and the command line over NODE_OPTIONS', () => {
    expect(
      sourceMapsFlag(['--enable-source-maps', '--no-enable-source-maps'], ''),
    ).toBe(false)
    expect(
      sourceMapsFlag(['--enable-source-maps'], '--no-enable-source-maps'),
    ).toBe(true)
    expect(
      sourceMapsFlag(
        [],
        ' --no-enable-source-maps  --enable-source-maps --expose-gc',
      ),
    ).toBe(true)
    expect(sourceMapsFlag([], '--no-enable-source-maps')).toBe(false)
  })

  it('reads the spellings Node accepts', () => {
    expect(
      sourceMapsFlag(['--no_enable_source_maps'], '--enable-source-maps'),
    ).toBe(false)
    // Node ignores the value: only the prefix decides.
    expect(sourceMapsFlag(['--no-enable-source-maps=true'], '')).toBe(false)
    expect(sourceMapsFlag(['--enable-source-maps=false'], '')).toBe(true)
  })

  it('reads quoted NODE_OPTIONS as Node does', () => {
    expect(sourceMapsFlag([], '"--no-enable-source-maps"')).toBe(false)
    expect(
      sourceMapsFlag([], '--require "./a b.js" --no-enable-source-maps'),
    ).toBe(false)
    expect(sourceMapsFlag([], '"--title=--enable-source-maps"')).toBe(undefined)
  })
})
