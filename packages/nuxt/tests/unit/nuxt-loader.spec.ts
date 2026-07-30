import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import {
  assertRoutingBase,
  importConsolaFrom,
  importH3From,
  importKitFrom,
  normalizeBase,
  restoreBase,
} from '../../src/nuxt-loader.ts'

const tempDirs: string[] = []
const fixtureRoot = resolve(import.meta.dirname, '../fixtures/dev-app')

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('Nuxt module loading contracts', () => {
  it.each([
    ['/', '/'],
    ['/admin', '/admin/'],
    ['/admin/', '/admin/'],
  ])('normalizes supported base %s to %s', (input, expected) => {
    expect(normalizeBase(input)).toBe(expected)
  })

  it.each(['', './', 'admin', 'https://x/'])(
    'rejects unsupported base %j',
    (base) => {
      expect(() => normalizeBase(base)).toThrow('absolute path bases only')
    },
  )

  it('requires a non-root base only for path routing', () => {
    expect(() => assertRoutingBase('path', '/')).toThrow(
      'Path-routed Neem proxy',
    )
    expect(() => assertRoutingBase('path', '/x/')).not.toThrow()
    expect(() => assertRoutingBase('default', '/')).not.toThrow()
    expect(() => assertRoutingBase('subdomain', '/')).not.toThrow()
    expect(() => assertRoutingBase(undefined, 'anything')).not.toThrow()
  })

  it.each([
    ['/foo', '/admin/foo'],
    ['/admin/foo', '/admin/foo'],
    ['/admin', '/admin'],
    [undefined, '/admin/'],
  ])('restores %j to %j under /admin/', (url, expected) => {
    const request: { url?: string } = { url }
    restoreBase(request, '/admin/')
    expect(request.url).toBe(expected)
  })

  it('explains when Nuxt cannot be resolved from an isolated app', async () => {
    const dir = await mkdtemp(resolve(tmpdir(), 'nmtjs-nuxt-loader-'))
    tempDirs.push(dir)
    const source = pathToFileURL(
      resolve(import.meta.dirname, '../../src/nuxt-loader.ts'),
    ).href
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    delete env.NODE_PATH
    // A fresh process avoids Vitest's package-resolution fallback to the project root.
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `import { importKitFrom } from ${JSON.stringify(source)}
try {
  await importKitFrom(${JSON.stringify(dir)})
  process.exitCode = 1
} catch (error) {
  if (!(error instanceof Error) || !error.message.includes('is nuxt installed')) process.exitCode = 1
}`,
      ],
      { encoding: 'utf8', env },
    )

    if (result.status !== 0) {
      throw new Error(
        `Isolated Nuxt resolution check failed:\n${result.stderr}`,
      )
    }
  })

  it('loads Nuxt kit through the fixture app installation', async () => {
    const kit = await importKitFrom(fixtureRoot)

    expect(kit).toEqual(
      expect.objectContaining({
        loadNuxt: expect.any(Function),
        buildNuxt: expect.any(Function),
        loadNuxtConfig: expect.any(Function),
      }),
    )
  })

  it('loads h3 through the Nuxt nitro installation', async () => {
    await expect(importH3From(fixtureRoot)).resolves.toEqual(
      expect.objectContaining({ toNodeListener: expect.any(Function) }),
    )
  })

  it('routes records through the resolved consola ESM singleton', async () => {
    const resolved = await importConsolaFrom(fixtureRoot)
    expect(resolved?.setReporters).toBeTypeOf('function')
    if (!resolved)
      throw new Error('Expected consola from the Nuxt installation')

    type Reporter = { log: (record: { args: unknown[] }) => void }
    const consola = resolved as typeof resolved & {
      warn: (message: string) => void
      options: { reporters: Reporter[] }
    }
    const original = [...consola.options.reporters]
    const records: Array<{ args: unknown[] }> = []

    try {
      consola.setReporters([{ log: (record) => records.push(record) }])
      consola.warn('nuxt-consola-singleton-probe')
      expect(records).toEqual([
        expect.objectContaining({ args: ['nuxt-consola-singleton-probe'] }),
      ])
    } finally {
      consola.setReporters(original)
    }
  })
})
