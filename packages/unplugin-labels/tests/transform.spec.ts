import { describe, expect, it } from 'vitest'

import { transformLabels } from '../src/transform.ts'

const ID = '/app/src/injectables.ts'

const transform = (
  code: string,
  options?: Parameters<typeof transformLabels>[2],
) => transformLabels(code, ID, { origin: false, ...options })?.code

describe('transformLabels', () => {
  it('labels a const declaration', () => {
    const code = `
      import { createFactoryInjectable } from '@nmtjs/core'
      const db = createFactoryInjectable({ create: () => ({}) })
    `
    expect(transform(code)).toContain(
      `createFactoryInjectable({ create: () => ({}) }, "db")`,
    )
  })

  it('labels exported declarations and aliased imports', () => {
    const code = `
      import { factory as f } from 'nmtjs'
      export const config = f(() => ({}))
    `
    expect(transform(code)).toContain(`f(() => ({}), "config")`)
  })

  it('labels zero-argument creators with an undefined placeholder', () => {
    const code = `
      import { createLazyInjectable } from '@nmtjs/core'
      const token = createLazyInjectable()
    `
    expect(transform(code)).toContain(
      `createLazyInjectable(undefined, "token")`,
    )
  })

  it('labels through $withType chains', () => {
    const code = `
      import { createLazyInjectable } from '@nmtjs/core'
      const db = createLazyInjectable().$withType<{ query: () => void }>()
    `
    expect(transform(code)).toContain(`createLazyInjectable(undefined, "db")`)
  })

  it('labels namespace imports', () => {
    const code = `
      import * as core from '@nmtjs/core'
      const cache = core.createValueInjectable({ entries: new Map() })
    `
    expect(transform(code)).toContain(`, "cache")`)
  })

  it('labels object properties and class fields', () => {
    const code = `
      import { lazy, value } from 'nmtjs'
      const bundle = { db: lazy() }
      class Services {
        cache = value(1)
      }
    `
    const output = transform(code)
    expect(output).toContain(`lazy(undefined, "db")`)
    expect(output).toContain(`value(1, "cache")`)
  })

  it('labels assignments including member assignments', () => {
    const code = `
      import { lazy } from 'nmtjs'
      let db
      db = lazy()
      this.metrics = lazy()
    `
    const output = transform(code)
    expect(output).toContain(`lazy(undefined, "db")`)
    expect(output).toContain(`lazy(undefined, "metrics")`)
  })

  it('keeps explicit labels', () => {
    const code = `
      import { createValueInjectable } from '@nmtjs/core'
      const db = createValueInjectable({}, 'custom')
    `
    expect(transform(code)).toBeUndefined()
  })

  it('ignores untracked modules and shadowed names', () => {
    const untracked = `
      import { factory } from 'some-lib'
      const db = factory({})
    `
    expect(transform(untracked)).toBeUndefined()

    const shadowed = `
      import { lazy } from 'nmtjs'
      const run = (lazy) => {
        const db = lazy()
        return db
      }
    `
    expect(transform(shadowed)).toBeUndefined()
  })

  it('ignores unnamed usages', () => {
    const code = `
      import { lazy } from 'nmtjs'
      export default lazy()
      register(lazy())
    `
    expect(transform(code)).toBeUndefined()
  })

  it('supports custom formatting and function lists', () => {
    const code = `
      import { procedure } from '@nmtjs/application'
      const getUser = procedure({ handler: () => null })
    `
    const output = transform(code, {
      functions: ['procedure'],
      format: (name, id) => `${id.split('/').pop()}#${name}`,
    })
    expect(output).toContain(`"injectables.ts#getUser")`)
  })

  it('produces a sourcemap', () => {
    const code = `
      import { lazy } from 'nmtjs'
      const db = lazy()
    `
    const result = transformLabels(code, '/app/a.ts', { origin: false })
    expect(result?.map).toBeTruthy()
    expect(result?.map.mappings.length).toBeGreaterThan(0)
  })
})

describe('transformLabels origins', () => {
  const withOrigin = (
    code: string,
    options?: Parameters<typeof transformLabels>[2],
  ) => transformLabels(code, ID, { root: '/app', ...options })?.code

  it('injects a root-relative declaration site by default', () => {
    const code = [
      `import { lazy, value } from 'nmtjs'`,
      `const db = lazy()`,
      `const cache = value(1)`,
    ].join('\n')
    const output = withOrigin(code)
    expect(output).toContain(`lazy(undefined, "db", "src/injectables.ts:2:12")`)
    expect(output).toContain(`value(1, "cache", "src/injectables.ts:3:15")`)
  })

  it('injects only the origin when an explicit label exists', () => {
    const code = [
      `import { createValueInjectable } from '@nmtjs/core'`,
      `const db = createValueInjectable({}, 'custom')`,
    ].join('\n')
    expect(withOrigin(code)).toContain(
      `createValueInjectable({}, 'custom', "src/injectables.ts:2:12")`,
    )
  })

  it('keeps explicit origins', () => {
    const code = [
      `import { createValueInjectable } from '@nmtjs/core'`,
      `const db = createValueInjectable({}, 'custom', 'somewhere:1:1')`,
    ].join('\n')
    expect(withOrigin(code)).toBeUndefined()
  })
})
