import { describe, expect, it } from 'vitest'

describe('neem.config consumer shape', () => {
  it('does not evaluate app or plugin entries when config uses type-only imports', async () => {
    delete (globalThis as any).__neemLazyAppLoaded
    delete (globalThis as any).__neemLazyBuildLoaded
    delete (globalThis as any).__neemLazyPluginLoaded

    const config = await import('../fixtures/lazy.config.ts').then(
      (module) => module.default,
    )

    expect(typeof config.apps.api.entry).toBe('function')
    expect(typeof config.apps.api.build).toBe('function')
    expect(typeof config.plugins?.[0]?.entry).toBe('function')
    expect((globalThis as any).__neemLazyAppLoaded).toBeUndefined()
    expect((globalThis as any).__neemLazyBuildLoaded).toBeUndefined()
    expect((globalThis as any).__neemLazyPluginLoaded).toBeUndefined()
  })
})
