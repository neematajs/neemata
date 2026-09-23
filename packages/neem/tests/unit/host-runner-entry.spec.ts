import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import type {
  HostRunnerCommand,
  HostRunnerData,
  HostRunnerResponse,
} from '../../src/internal/host/runner-protocol.ts'
import { createTempDir } from '../support/temp.ts'

const RUNNER_ENTRY = new URL(
  '../../src/internal/host/runner-entry.ts',
  import.meta.url,
)

describe('host runner entry', () => {
  it('stops a host whose factory resolves after stop was requested', async () => {
    const runner = await createRunner(`
      import { appendFileSync } from 'node:fs'
      const record = (event) =>
        appendFileSync(process.env.EVENTS_FILE, event + '\\n')
      export default Object.assign(
        async () => {
          record('create')
          await new Promise((resolve) => setTimeout(resolve, 150))
          record('created')
          return {
            start() { record('start') },
            async stop() { record('stop') },
          }
        },
        { [Symbol.for('neem:runtime-host')]: true },
      )
    `)
    await runner.ready

    const start = runner.request({ type: 'start', threads: [] })
    await vi.waitFor(async () =>
      expect(await runner.events()).toContain('create'),
    )
    const stop = runner.request({ type: 'stop' })

    expect(await stop).toMatchObject({ type: 'result' })
    expect(await start).toMatchObject({
      type: 'error',
      error: { message: 'Neem runtime host stopped before start' },
    })
    expect(await runner.events()).toEqual(['create', 'created', 'stop'])

    // A second stop request is the same stop, not another one.
    expect(await runner.request({ type: 'stop' })).toMatchObject({
      type: 'result',
    })
    expect(await runner.events()).toEqual(['create', 'created', 'stop'])
  })

  it('stops a host still being created when shut down without a stop', async () => {
    const runner = await createRunner(`
      import { appendFileSync } from 'node:fs'
      const record = (event) =>
        appendFileSync(process.env.EVENTS_FILE, event + '\\n')
      export default Object.assign(
        async () => {
          record('create')
          await new Promise((resolve) => setTimeout(resolve, 150))
          return { async stop() { record('stop') } }
        },
        { [Symbol.for('neem:runtime-host')]: true },
      )
    `)
    await runner.ready

    void runner.request({ type: 'start', threads: [] })
    await vi.waitFor(async () =>
      expect(await runner.events()).toContain('create'),
    )
    const shutdown = runner.request({ type: 'shutdown' })

    expect(await shutdown).toMatchObject({ type: 'result' })
    expect(await runner.events()).toEqual(['create', 'stop'])
  })
})

async function createRunner(hostSource: string) {
  const outDir = await createTempDir('neem-host-runner-entry-')
  const hostFile = resolve(outDir, 'host.mjs')
  const eventsFile = resolve(outDir, 'events.txt')
  await writeFile(hostFile, hostSource)
  await writeFile(eventsFile, '')
  const artifact = (id: string) => ({
    id,
    kind: 'module' as const,
    owner: { type: 'runtime' as const, name: 'api' },
    file: hostFile,
    outDir,
  })
  const data: HostRunnerData = {
    mode: 'development',
    runtimeName: 'api',
    hostArtifact: artifact('host'),
    plannerArtifact: artifact('planner'),
    outDir,
  }
  const worker = new Worker(RUNNER_ENTRY, {
    workerData: data,
    env: { ...process.env, EVENTS_FILE: eventsFile },
  })
  onTestFinished(async () => {
    await worker.terminate()
  })

  const pending = new Map<number, (response: HostRunnerResponse) => void>()
  let ready!: () => void
  const readyPromise = new Promise<void>((resolve) => (ready = resolve))
  worker.on('message', (message: HostRunnerResponse) => {
    if (message.type === 'ready') ready()
    if ('id' in message) pending.get(message.id)?.(message)
  })
  let nextId = 1

  return {
    ready: readyPromise,
    request(command: HostRunnerCommand) {
      const id = nextId++
      return new Promise<HostRunnerResponse>((resolve) => {
        pending.set(id, resolve)
        worker.postMessage({ ...command, id })
      })
    },
    async events() {
      return (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean)
    },
  }
}
