import * as fs from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import { describe, expect, it, onTestFinished, vi } from 'vitest'

import { createTempDir } from '../support/temp.ts'
import {
  createNeemFixture,
  getDistinctFreePorts,
  readRuntimeEvents,
  spawnNode,
  waitFor,
} from './support/e2e.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return { ...fs, cp: vi.fn(fs.cp) }
})

describe('Neem e2e process harness', () => {
  it('stops children before removing their temporary files', async () => {
    // These assertions run after the cleanup hooks registered below them.
    onTestFinished(async () => {
      await expect(fs.access(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    const dir = await createTempDir('neem-harness-')
    const marker = resolve(dir, 'stopped')
    onTestFinished(async () => {
      expect(neem.child.exitCode).toBe(0)
      await expect(fs.readFile(marker, 'utf8')).resolves.toBe('stopped')
    })
    const neem = spawnNode([
      '--input-type=module',
      '-e',
      `
        import { writeFileSync } from 'node:fs'
        process.on('SIGTERM', () => {
          writeFileSync(${JSON.stringify(marker)}, 'stopped')
          process.exit(0)
        })
        process.stdout.write('ready')
        setInterval(() => {}, 1000)
      `,
    ])

    await waitFor(() => neem.stdout().includes('ready'), 1_000)
    // Deliberately leave the process running to exercise test-owned shutdown.
  })

  it('removes a partially copied fixture when setup rejects', async () => {
    let dir = ''
    onTestFinished(async () => {
      expect(dir).not.toBe('')
      await expect(fs.access(dir)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    const copy = vi.mocked(fs.cp).mockImplementationOnce(async (_, target) => {
      dir = dirname(String(target))
      await fs.writeFile(resolve(dir, 'partial-copy'), 'partial')
      throw new Error('Fixture copy failed')
    })

    try {
      await expect(createNeemFixture()).rejects.toThrow('Fixture copy failed')
    } finally {
      copy.mockRestore()
    }
  })

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
    const dir = await createTempDir('neem-harness-')
    const eventsFile = resolve(dir, 'events.jsonl')
    await fs.writeFile(eventsFile, '{"event":"complete"}\n{"event":"partial"')

    await expect(readRuntimeEvents(eventsFile)).resolves.toEqual([
      { event: 'complete' },
    ])
  })

  it('allocates distinct free ports', async () => {
    await expect(getDistinctFreePorts(3)).resolves.toHaveLength(3)
  })
})
