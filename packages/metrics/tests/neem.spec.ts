import { describe, expect, it } from 'vitest'

describe('@nmtjs/metrics/neem', () => {
  it('exposes metrics plugin as default export', async () => {
    const mod = await import('../src/neem/index.ts')

    expect(mod.default).toEqual(expect.any(Function))
  })
})
