import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  getDistinctFreePorts,
  readRuntimeEvents,
  spawnNode,
  waitFor,
} from './support/e2e.ts'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

describe('Neem e2e process harness', () => {
  it('force-kills a child that ignores SIGTERM', async () => {
    const neem = spawnNode([
      '-e',
      [
        "process.on('SIGTERM', () => {})",
        "process.stdout.write('ready')",
        'setInterval(() => {}, 1000)',
      ].join(';'),
    ])

    await waitFor(() => neem.stdout().includes('ready'), 1_000)

    const exit = await neem.stop({ killAfterMs: 50 })

    expect(exit).toEqual({ code: null, signal: 'SIGKILL' })

    await expect(
      neem.waitForEvent((event) => event.event === 'never', 1),
    ).rejects.toThrow('Process was force-killed after 50ms')
  })

  it('adds sequence and timestamp metadata to probe events', async () => {
    const neem = spawnNode([
      '-e',
      [
        "process.send({ source: 'neem:test-probe', event: 'first' })",
        "process.send({ source: 'neem:test-probe', event: 'second' })",
      ].join(';'),
    ])

    await neem.waitForExit()

    expect(neem.events()).toEqual([
      expect.objectContaining({
        event: 'first',
        pid: expect.any(Number),
        sequence: 1,
        timestamp: expect.any(String),
      }),
      expect.objectContaining({
        event: 'second',
        pid: expect.any(Number),
        sequence: 2,
        timestamp: expect.any(String),
      }),
    ])
    expect(Date.parse(String(neem.events()[0]?.timestamp))).not.toBeNaN()
  })

  it('ignores an incomplete trailing runtime event line', async () => {
    const dir = await useTempDir()
    const eventsFile = resolve(dir, 'events.jsonl')
    await writeFile(eventsFile, '{"event":"complete"}\n{"event":"partial"')

    await expect(readRuntimeEvents(eventsFile)).resolves.toEqual([
      { event: 'complete' },
    ])
  })

  it('allocates distinct free ports', async () => {
    await expect(getDistinctFreePorts(3)).resolves.toHaveLength(3)
  })
})

async function useTempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'neem-harness-'))
  tempDirs.push(dir)
  return dir
}
