import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'

import { afterEach, describe, expect, it } from 'vitest'

import { waitFor } from './support/support.ts'

type WorkerMessage =
  | { type: 'ready'; upstreams: Array<{ type: string; url: string }> }
  | { type: 'log'; level: string; message: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string }

type HmrMessage = { type: unknown }

type RunningWorker = {
  worker: Worker
  messages: WorkerMessage[]
  stdout: () => string
  stderr: () => string
  stop: () => Promise<void>
}

const fixtureRoot = resolve(import.meta.dirname, '../fixtures/dev-app')
const workerEntry = resolve(import.meta.dirname, 'support/dev-worker.mjs')
const moduleUrl = pathToFileURL(
  resolve(import.meta.dirname, '../../dist/neem/dev.js'),
).href
const workers: RunningWorker[] = []

afterEach(async () => {
  for (const worker of workers.splice(0).reverse()) await worker.stop()
  await Promise.all(
    ['.nuxt', '.output', 'node_modules'].map((name) =>
      rm(resolve(fixtureRoot, name), { recursive: true, force: true }),
    ),
  )
})

describe('Nuxt development runtime', () => {
  it('serves SSR and API requests while bridging Nuxt logs', async () => {
    const running = startWorker({ root: fixtureRoot })
    const ready = await waitForReady(running)

    expect(ready.upstreams).toHaveLength(2)
    expect(ready.upstreams.map((upstream) => upstream.type)).toEqual([
      'http',
      'ws',
    ])
    expect(ready.upstreams[0]?.url).toBe(ready.upstreams[1]?.url)
    const url = ready.upstreams[0]?.url
    if (!url) throw new Error('Dev runtime returned no HTTP upstream')

    const html = await (await fetch(url)).text()
    expect(html).toContain('nuxt-dev-marker')
    expect(html).toContain('hello-from-dev-api')
    await expect((await fetch(`${url}/api/hello`)).json()).resolves.toEqual({
      message: 'hello-from-dev-api',
    })
    const logs = running.messages.flatMap((message) =>
      message.type === 'log' ? [message.message] : [],
    )
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Vite client built'),
        expect.stringContaining('[nitro]'),
      ]),
    )
    expect(running.stdout()).not.toContain('Vite client built')
  }, 60_000)

  it('pushes an HMR update after the client module enters Vite graph', async () => {
    const running = startWorker({ root: fixtureRoot })
    const ready = await waitForReady(running)
    const url = ready.upstreams[0]?.url
    if (!url) throw new Error('Dev runtime returned no HTTP upstream')

    // Client transform first: Vite only pushes updates for modules in its client graph.
    expect((await fetch(`${url}/_nuxt/app.vue`)).status).toBe(200)
    const hmr = openHmr(`${url.replace('http:', 'ws:')}/_nuxt/`)
    await waitFor(
      () => hmr.messages.some((message) => message.type === 'connected'),
      10_000,
      () => `worker stderr:\n${running.stderr()}`,
    )

    const appFile = resolve(fixtureRoot, 'app.vue')
    const original = await readFile(appFile, 'utf8')
    try {
      await writeFile(
        appFile,
        original.replace('nuxt-dev-marker', 'nuxt-dev-marker-updated'),
      )
      await waitFor(
        () =>
          hmr.messages.some(
            (message) =>
              message.type === 'update' || message.type === 'full-reload',
          ),
        15_000,
        () => JSON.stringify(hmr.messages),
      )
    } finally {
      await writeFile(appFile, original)
      hmr.socket.close()
    }
  }, 60_000)

  it('serves stripped and direct requests under path routing', async () => {
    const running = startWorker({
      root: fixtureRoot,
      base: '/admin/',
      routing: 'path',
    })
    const ready = await waitForReady(running)
    const url = ready.upstreams[0]?.url
    if (!url) throw new Error('Dev runtime returned no HTTP upstream')

    expect(await (await fetch(url)).text()).toContain('nuxt-dev-marker')
    expect(await (await fetch(`${url}/admin/`)).text()).toContain(
      'nuxt-dev-marker',
    )
    const hmr = openHmr(`${url.replace('http:', 'ws:')}/admin/_nuxt/`)
    await waitFor(
      () => hmr.messages.some((message) => message.type === 'connected'),
      10_000,
      () => `worker stderr:\n${running.stderr()}`,
    )
    hmr.socket.close()
  }, 60_000)

  it('refuses connections after stop completes', async () => {
    const running = startWorker({ root: fixtureRoot })
    const ready = await waitForReady(running)
    const url = ready.upstreams[0]?.url
    if (!url) throw new Error('Dev runtime returned no HTTP upstream')

    await running.stop()

    await expect(fetch(url)).rejects.toThrow()
  }, 60_000)
})

function startWorker(options: {
  root: string
  base?: string
  routing?: string
}): RunningWorker {
  const messages: WorkerMessage[] = []
  let stdout = ''
  let stderr = ''
  let stopped = false
  let exited = false
  // Vitest marks the environment as a test run (NODE_ENV/TEST/VITEST), which
  // makes Nuxt silence its consola logger — the worker must look like a real
  // dev process for the log bridge to have records to route.
  const { TEST: _test, VITEST: _vitest, ...env } = process.env
  const worker = new Worker(workerEntry, {
    env: { ...env, NODE_ENV: 'development' },
    workerData: { moduleUrl, options },
    stdout: true,
    stderr: true,
  })
  worker.on('message', (message: WorkerMessage) => messages.push(message))
  worker.on('error', (error) =>
    messages.push({ type: 'error', message: error.stack ?? error.message }),
  )
  worker.on('exit', () => (exited = true))
  worker.stdout?.on('data', (chunk) => (stdout += String(chunk)))
  worker.stderr?.on('data', (chunk) => (stderr += String(chunk)))
  const running: RunningWorker = {
    worker,
    messages,
    stdout: () => stdout,
    stderr: () => stderr,
    async stop() {
      if (stopped || exited) return
      worker.postMessage({ type: 'stop' })
      await waitFor(
        () => exited || messages.some((message) => message.type === 'stopped'),
        30_000,
        () => `worker stderr:\n${stderr}`,
      )
      stopped = true
      await worker.terminate()
    },
  }
  workers.push(running)
  return running
}

async function waitForReady(running: RunningWorker): Promise<{
  type: 'ready'
  upstreams: Array<{ type: string; url: string }>
}> {
  return await waitFor(
    () => {
      const error = running.messages.find((message) => message.type === 'error')
      if (error?.type === 'error') throw new Error(error.message)
      return running.messages.find((message) => message.type === 'ready')
    },
    45_000,
    () => `stdout:\n${running.stdout()}\nstderr:\n${running.stderr()}`,
  )
}

function openHmr(url: string): { socket: WebSocket; messages: HmrMessage[] } {
  const messages: HmrMessage[] = []
  const socket = new WebSocket(url, 'vite-hmr')
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return
    const value: unknown = JSON.parse(event.data)
    if (value && typeof value === 'object' && 'type' in value) {
      messages.push({ type: value.type })
    }
  })
  return { socket, messages }
}
