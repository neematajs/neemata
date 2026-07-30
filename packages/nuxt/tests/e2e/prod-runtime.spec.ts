import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

type Runtime = {
  finished: Promise<void>
  start: () => Promise<Array<{ type: string; url: string }>>
  stop: () => Promise<void>
}

type ProdOptions = { base?: string; routing?: string; assetsDir?: string }
type ProdFactory = (
  context: { logger: { info: (message: string) => void } },
  options: ProdOptions,
) => Runtime

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('Nuxt production runtime', () => {
  it('serves static files and falls through non-static requests', async () => {
    const { runtime, url } = await startRuntime({
      base: '/',
      assetsDir: '/_nuxt/',
    })

    const asset = await fetch(`${url}/_nuxt/entry-abc123.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('content-type')).toBe('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')

    const root = await fetch(`${url}/root.txt`)
    expect(await root.text()).toBe('root-static')
    expect(root.headers.get('cache-control')).toBe('no-cache')

    const about = await fetch(`${url}/about`)
    expect(await about.text()).toContain('<h1>prerendered-about</h1>')

    const missing = await fetch(`${url}/missing`)
    await expect(missing.json()).resolves.toMatchObject({
      method: 'GET',
      url: '/missing',
    })

    const post = await fetch(`${url}/about`, { method: 'POST' })
    await expect(post.json()).resolves.toMatchObject({
      method: 'POST',
      url: '/about',
    })

    const head = await fetch(`${url}/root.txt`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    expect(head.headers.get('content-length')).toBe(
      String(Buffer.byteLength('root-static')),
    )

    for (const path of ['/..%2fsecret', '/../secret']) {
      const response = await rawRequest(url, path)
      expect(response.body).not.toContain('outside-public-secret')
    }

    await runtime.stop()
  })

  it('strips a default-routing base only for static lookup', async () => {
    const { runtime, url } = await startRuntime({
      base: '/admin/',
      assetsDir: '/_nuxt/',
    })

    expect(await (await fetch(`${url}/admin/root.txt`)).text()).toBe(
      'root-static',
    )
    await expect(
      (await fetch(`${url}/root.txt`)).json(),
    ).resolves.toMatchObject({ url: '/root.txt' })
    await expect(
      (await fetch(`${url}/admin/page`)).json(),
    ).resolves.toMatchObject({ url: '/admin/page' })

    await runtime.stop()
  })

  it('restores a path-routing base before the Nitro listener', async () => {
    const { runtime, url } = await startRuntime({
      base: '/admin/',
      routing: 'path',
      assetsDir: '/_nuxt/',
    })

    expect(await (await fetch(`${url}/root.txt`)).text()).toBe('root-static')
    await expect((await fetch(`${url}/page`)).json()).resolves.toMatchObject({
      url: '/admin/page',
    })

    await runtime.stop()
  })

  it('explains when the Nitro server artifact is missing', async () => {
    const { factory } = await createArtifact(false)
    const runtime = factory({ logger: { info: () => {} } }, {})
    cleanups.push(() => runtime.stop())

    await expect(runtime.start()).rejects.toThrow(
      'was not produced by "neem build"',
    )
  })
})

async function startRuntime(options: ProdOptions): Promise<{
  runtime: Runtime
  url: string
}> {
  const { factory } = await createArtifact(true)
  const runtime = factory({ logger: { info: () => {} } }, options)
  cleanups.push(() => runtime.stop())
  const upstreams = await runtime.start()
  const url = upstreams[0]?.url
  if (!url) throw new Error('Production runtime returned no HTTP upstream')
  return { runtime, url }
}

async function createArtifact(withServer: boolean): Promise<{
  factory: ProdFactory
}> {
  const dir = await mkdtemp(resolve(tmpdir(), 'nmtjs-nuxt-prod-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  const distDir = resolve(dir, 'dist')
  await cp(resolve(import.meta.dirname, '../../dist'), distDir, {
    filter: (source) => !source.endsWith('.map'),
    recursive: true,
  })
  // The copied files still reference the excluded maps; drop the comments so
  // vitest's module loader does not log an ENOENT for every import.
  for (const entry of await readdir(distDir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue
    const path = join(entry.parentPath, entry.name)
    const content = await readFile(path, 'utf8')
    const stripped = content.replace(/^\/\/# sourceMappingURL=.*$/m, '')
    if (stripped !== content) await writeFile(path, stripped)
  }
  const appDir = resolve(distDir, 'neem/app')
  const fixtureDir = resolve(import.meta.dirname, '../fixtures/prod-app')
  await cp(fixtureDir, appDir, {
    recursive: true,
    filter: (source) =>
      withServer || !relative(fixtureDir, source).startsWith('server'),
  })
  const module = (await import(
    pathToFileURL(resolve(distDir, 'neem/prod.js')).href
  )) as { default: ProdFactory }
  return { factory: module.default }
}

async function rawRequest(
  origin: string,
  path: string,
): Promise<{ status: number; body: string }> {
  const target = new URL(origin)
  return await new Promise((resolveResponse, reject) => {
    const req = request(
      { hostname: target.hostname, port: target.port, path },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.once('end', () =>
          resolveResponse({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      },
    )
    req.once('error', reject)
    req.end()
  })
}
