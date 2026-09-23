import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Worker } from 'node:worker_threads'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import type {
  HostRunnerCommands,
  HostRunnerData,
} from '../../src/internal/host/runner-protocol.ts'
import { isRpcEvent, RpcChannel } from '../../src/internal/rpc.ts'
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

    const start = runner.rpc.request('start', { threads: [] })
    start.catch(() => {})
    await vi.waitFor(async () =>
      expect(await runner.events()).toContain('create'),
    )
    const stop = runner.rpc.request('stop', {})

    await expect(stop).resolves.toBeUndefined()
    await expect(start).rejects.toThrow(
      'Neem runtime host stopped before start',
    )
    expect(await runner.events()).toEqual(['create', 'created', 'stop'])

    // A second stop request is the same stop, not another one.
    await expect(runner.rpc.request('stop', {})).resolves.toBeUndefined()
    expect(await runner.events()).toEqual(['create', 'created', 'stop'])
  })

  it('replies with an error to a command it does not serve', async () => {
    const runner = await createRunner(`export default {}`)
    await runner.ready

    const unknown = runner.rpc as unknown as RpcChannel<{
      reload: { params: Record<string, never>; result: void }
    }>
    await expect(unknown.request('reload', {})).rejects.toThrow(
      'Neem host runner received unknown command [reload]',
    )
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

    runner.rpc.request('start', { threads: [] }).catch(() => {})
    await vi.waitFor(async () =>
      expect(await runner.events()).toContain('create'),
    )
    const shutdown = runner.rpc.request('shutdown', {})

    await expect(shutdown).resolves.toBeUndefined()
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

  const rpc = new RpcChannel<HostRunnerCommands>({
    post: (message, transfer) => worker.postMessage(message, transfer),
    timeoutMs: () => 5_000,
    timeoutMessage: (type) => `host runner request [${type}] timed out`,
  })
  let ready!: () => void
  const readyPromise = new Promise<void>((resolve) => (ready = resolve))
  worker.on('message', (message: unknown) => {
    if (rpc.settle(message)) return
    if (isRpcEvent<{ type: string }>(message) && message.event.type === 'ready')
      ready()
  })

  return {
    ready: readyPromise,
    rpc,
    async events() {
      return (await readFile(eventsFile, 'utf8')).split('\n').filter(Boolean)
    },
  }
}
