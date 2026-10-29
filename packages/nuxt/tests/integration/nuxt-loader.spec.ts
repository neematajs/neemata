import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { NeemBuildContext } from '@nmtjs/neem'
import { afterEach, describe, expect, it } from 'vitest'

import type { NuxtInstance } from '../../src/nuxt-loader.ts'
import {
  applyNuxtSourceMaps,
  assertRoutingBase,
  importConsolaFrom,
  importH3From,
  importKitFrom,
  normalizeBase,
  nuxtSourceMapProbe,
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
  if (!(error instanceof Error) || !error.message.includes('is nuxt installed') || !(error.cause instanceof Error)) process.exitCode = 1
}`,
      ],
      // spawnSync blocks the event loop, so vitest's own timeout cannot
      // preempt a stuck child.
      { encoding: 'utf8', env, timeout: 30_000 },
    )

    if (result.status !== 0) {
      throw new Error(
        `Isolated Nuxt resolution check failed:\n${result.stderr}`,
      )
    }
  })

  it.runIf(!globalThis.Bun)(
    'falls back to the runtime resolver for non-node_modules layouts',
    async () => {
      const dir = await mkdtemp(resolve(tmpdir(), 'nmtjs-nuxt-loader-'))
      tempDirs.push(dir)
      const source = pathToFileURL(
        resolve(import.meta.dirname, '../../src/nuxt-loader.ts'),
      ).href
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NODE_PATH: resolve(import.meta.dirname, '../../node_modules'),
      }
      delete env.NODE_OPTIONS
      const result = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `import { importKitFrom } from ${JSON.stringify(source)}
const kit = await importKitFrom(${JSON.stringify(dir)})
if (typeof kit.loadNuxt !== 'function') process.exitCode = 1`,
        ],
        { encoding: 'utf8', env, timeout: 30_000 },
      )

      if (result.status !== 0) {
        throw new Error(
          `Nuxt runtime resolution fallback check failed:\n${result.stderr}`,
        )
      }
    },
  )

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

describe('applyNuxtSourceMaps', () => {
  const unset = nuxtSourceMapProbe(true)!.sourcemap.client
  // Resolved options after loading with the probe: `unset` marks a side no
  // config source sets.
  const apply = (
    sourcemap: NeemBuildContext['sourcemap'],
    resolved: object = {},
    dev = false,
  ) => {
    const nuxt = {
      options: {
        dev,
        sourcemap: { client: unset, server: unset },
        ...resolved,
      },
    } as unknown as NuxtInstance
    applyNuxtSourceMaps(nuxt, sourcemap)
    return nuxt.options.sourcemap
  }

  it("applies Neem's setting to the sides the app leaves unset", () => {
    expect(apply(true)).toEqual({ client: true, server: true })
    expect(apply(false)).toEqual({ client: false, server: false })
    expect(apply('inline')).toEqual({ client: true, server: true })
    expect(
      apply(true, { sourcemap: { client: 'hidden', server: unset } }),
    ).toEqual({ client: 'hidden', server: true })
    expect(nuxtSourceMapProbe(undefined)).toBeUndefined()
  })

  it("keeps Nuxt's default for a side whose Vite or Nitro maps the app sets", () => {
    for (const resolved of [
      { vite: { $server: { build: { sourcemap: true } } } },
      { vite: { environments: { ssr: { build: { sourcemap: true } } } } },
      { nitro: { sourceMap: true } },
      { nitro: { rollupConfig: { output: { sourcemap: 'hidden' } } } },
    ]) {
      expect(apply(false, resolved)).toEqual({ client: false, server: true })
    }
    expect(
      apply(
        false,
        {
          vite: {
            build: { rolldownOptions: { output: [{ sourcemap: true }] } },
          },
        },
        true,
      ),
    ).toEqual({ client: true, server: true })
    // Turning a side on leaves those settings to refine it.
    expect(apply(true, { nitro: { sourceMap: false } })).toEqual({
      client: true,
      server: true,
    })
  })

  it('sees every config source Nuxt merges, including .nuxtrc', async () => {
    // Inside the package, so the app resolves nuxt from here.
    const root = await mkdtemp(resolve(import.meta.dirname, '../../.tmp-maps-'))
    tempDirs.push(root)
    await cp(fixtureRoot, root, { recursive: true })
    await writeFile(resolve(root, '.nuxtrc'), 'sourcemap.client=true\n')
    const kit = await importKitFrom(root)
    const nuxt = await kit.loadNuxt({
      cwd: root,
      dev: false,
      ready: false,
      defaults: nuxtSourceMapProbe(false),
      overrides: { telemetry: false },
    })
    try {
      // The rc file's side wins; Neem's setting fills the other.
      applyNuxtSourceMaps(nuxt, false)
      expect(nuxt.options.sourcemap).toEqual({ client: true, server: false })
    } finally {
      await nuxt.close()
    }
  }, 60_000)
})
