import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'

const neemBin = resolve(import.meta.dirname, '../../../neem/bin/neem.js')
const processes: ChildProcess[] = []
let appDir = ''
let origin = ''

beforeAll(async () => {
  const port = await getFreePort()
  origin = `http://127.0.0.1:${port}`
  // Inside the package, so the app resolves vite and the preset from here.
  appDir = await mkdtemp(resolve(import.meta.dirname, '../../.tmp-preview-'))
  await cp(resolve(import.meta.dirname, '../../playground'), appDir, {
    recursive: true,
    filter: (source) => !/[/\\](?:dist|\.neem|node_modules)$/.test(source),
  })
  await writeFile(
    resolve(appDir, 'neem.config.ts'),
    `import { defineConfig } from '@nmtjs/neem'
export default defineConfig({
  runtimes: ['./neem.runtime.ts'],
  server: { hostname: '127.0.0.1', port: ${port} },
})
`,
  )
  // A deployment config that keeps maps away from browsers.
  await writeFile(
    resolve(appDir, 'vite.config.ts'),
    `import { defineConfig } from 'vite'
export default defineConfig({
  define: { __CONFIG_TAG__: '"tag"' },
  build: { sourcemap: 'hidden' },
})
`,
  )
}, 30_000)

afterEach(async () => {
  for (const child of processes.splice(0)) await stop(child)
})

afterAll(async () => {
  if (appDir) await rm(appDir, { recursive: true, force: true })
})

it('keeps the app source-map setting in a regular build', async () => {
  const build = run(['build'])
  expect(await exited(build.child), build.output()).toBe(0)
  const assets = resolve(appDir, 'dist/runtime/web/worker/app/assets')
  const script = await findScript(assets)
  // `hidden` writes maps without linking them.
  expect(await readFile(resolve(assets, script), 'utf8')).not.toContain(
    'sourceMappingURL',
  )
  expect(await readdir(assets)).toContain(`${script}.map`)
}, 120_000)

it('serves a preview whose browser bundle links its source map', async () => {
  const preview = run(['preview'])
  const html = await waitFor(async () => {
    const response = await fetch(origin)
    const body = await response.text()
    return response.status === 200 && body.includes('id="app"') ? body : false
  }, preview.output)
  const script = html.match(/src="([^"]+\.js)"/)?.[1]
  if (!script) throw new Error(`No script in preview HTML:\n${html}`)
  const asset = new URL(script, origin)
  const source = await (await fetch(asset)).text()
  expect(source).toMatch(/\/\/# sourceMappingURL=\S+\.js\.map\s*$/)
  const map = await fetch(`${asset.href}.map`)
  expect(map.status).toBe(200)
  const { sources } = (await map.json()) as { sources: string[] }
  expect(sources).toEqual(
    expect.arrayContaining([expect.stringMatching(/src\/main\.ts$/)]),
  )
}, 120_000)

function run(args: readonly string[]) {
  let output = ''
  const child = spawn(process.execPath, [neemBin, ...args], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => (output += String(chunk)))
  child.stderr.on('data', (chunk) => (output += String(chunk)))
  processes.push(child)
  return { child, output: () => output }
}

function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(child.exitCode)
  }
  return new Promise((resolveExit) =>
    child.once('exit', (code) => resolveExit(code)),
  )
}

async function stop(child: ChildProcess): Promise<void> {
  const exit = exited(child)
  child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await exit
  clearTimeout(timer)
}

async function findScript(dir: string): Promise<string> {
  const script = (await readdir(dir)).find((file) => file.endsWith('.js'))
  if (!script) throw new Error(`No script in ${dir}`)
  return script
}

async function waitFor<T>(
  poll: () => Promise<T | false>,
  context: () => string,
): Promise<T> {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const result = await poll().catch(() => false as const)
    if (result) return result
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
  }
  throw new Error(`Timed out waiting for the preview:\n${context()}`)
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close()
      if (address && typeof address === 'object') resolvePort(address.port)
      else reject(new Error('Failed to allocate a local TCP port'))
    })
  })
}
