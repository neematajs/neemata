import { describe, expect, it } from 'vitest'

import { normalizeNeemConfig } from '../../../packages/neem/src/public/config.ts'

describe('neem.config consumer shape', () => {
  it('does not evaluate runtime entries when config uses type-only imports', async () => {
    delete (globalThis as any).__neemLazyAppLoaded
    delete (globalThis as any).__neemLazyBuildLoaded

    const config = await import('../fixtures/lazy.config.ts').then(
      (module) => module.default,
    )
    const normalizedConfig = normalizeNeemConfig(config)

    expect(normalizedConfig.runtimes.api.worker.entry).toBe('./lazy.app.ts')
    expect(normalizedConfig.runtimes.api.worker).toMatchObject({
      build: { rolldown: { external: ['lazy-runtime-external'] } },
    })
    expect((globalThis as any).__neemLazyAppLoaded).toBeUndefined()
  })
})
