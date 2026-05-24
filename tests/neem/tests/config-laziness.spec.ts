import { describe, expect, it } from 'vitest'

describe('neem.config consumer shape', () => {
  it('does not evaluate runtime entries when config uses type-only imports', async () => {
    delete (globalThis as any).__neemLazyAppLoaded
    delete (globalThis as any).__neemLazyBuildLoaded

    const config = await import('../fixtures/lazy.config.ts').then(
      (module) => module.default,
    )

    expect(config.runtimes.api.entry).toBe('./lazy.app.ts')
    expect(config.runtimes.api.build).toBe('./lazy.build.ts')
    expect((globalThis as any).__neemLazyAppLoaded).toBeUndefined()
    expect((globalThis as any).__neemLazyBuildLoaded).toBeUndefined()
  })
})
