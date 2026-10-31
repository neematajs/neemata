import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { describe, expect, it, onTestFinished } from 'vitest'

import {
  groupMemberProbe,
  withoutInspectorFlags,
  withoutInspectorNodeOptions,
} from '../../src/internal/commands/preview.ts'
import { createTempDir } from '../support/temp.ts'

describe('preview build flags', () => {
  it('drops inspector flags together with a separate value', () => {
    expect(
      withoutInspectorFlags([
        '--inspect-port',
        '0',
        '--inspect=9230',
        '--inspect-brk',
        '--debug-port=1',
        '--inspect-publish-uid',
        'http',
        '--import',
        './loader.mjs',
        '--conditions=development',
      ]),
    ).toEqual(['--import', './loader.mjs', '--conditions=development'])
  })

  it('keeps a value that only follows a flag without one', () => {
    // `--inspect` takes only `=value`; the next argument is its own option.
    expect(
      withoutInspectorFlags(['--inspect', '--enable-source-maps']),
    ).toEqual(['--enable-source-maps'])
  })

  it('removes inspector options from NODE_OPTIONS and keeps the rest verbatim', () => {
    expect(
      withoutInspectorNodeOptions(
        '--inspect-brk=0 --import "./my loader.mjs"  --inspect-port 9300 --conditions=dev',
      ),
    ).toBe('--import "./my loader.mjs" --conditions=dev')
    expect(
      withoutInspectorNodeOptions('"--inspect" --max-old-space-size=4096'),
    ).toBe('--max-old-space-size=4096')
  })

  it('returns NODE_OPTIONS untouched when nothing is removed', () => {
    const value = '--import  ./a.mjs'
    expect(withoutInspectorNodeOptions(value)).toBe(value)
  })
})

describe('preview build process group probe', () => {
  async function procfs(stats: Record<string, string>) {
    const root = await createTempDir('neem-procfs-')
    await writeStats(root, stats)
    return root
  }
  async function writeStats(root: string, stats: Record<string, string>) {
    for (const [pid, stat] of Object.entries(stats)) {
      await mkdir(join(root, pid), { recursive: true })
      await writeFile(join(root, pid, 'stat'), stat)
    }
  }

  it('ignores zombies, other groups and processes reaped since the listing', async () => {
    const root = await procfs({
      '100': '100 (node) Z 1 100 100 0 -1',
      '101': '101 (x) X 1 100 100 0 -1',
      // A live process in another group whose name mimics a member's fields.
      '102': '102 (a) S 1 100) S 1 200 200 0 -1',
    })
    await mkdir(join(root, '103'))
    await mkdir(join(root, 'self'))

    expect(await groupMemberProbe(100, root)()).toBe(false)
  })

  it('reports a running member and notices once it becomes a zombie', async () => {
    const root = await procfs({
      '100': '100 (node) Z 1 100 100 0 -1',
      '104': '104 (helper (sub)) S 1 100 100 0 -1',
    })
    const probe = groupMemberProbe(100, root)

    expect(await probe()).toBe(true)
    await writeStats(root, { '104': '104 (helper (sub)) Z 1 100 100 0 -1' })
    expect(await probe()).toBe(false)
  })

  it('counts unreadable or malformed entries as running', async () => {
    const unreadable = await procfs({})
    // Reading a directory fails with EISDIR, not as a reaped process.
    await mkdir(join(unreadable, '105', 'stat'), { recursive: true })
    expect(await groupMemberProbe(100, unreadable)()).toBe(true)

    const malformed = await procfs({ '106': '106 node' })
    expect(await groupMemberProbe(100, malformed)()).toBe(true)

    const missing = join(await procfs({}), 'proc')
    expect(await groupMemberProbe(100, missing)()).toBe(true)
  })

  it.runIf(process.platform === 'linux')(
    'tells a zombie-only group from one with a process that ignores SIGTERM',
    async () => {
      // Job control gives the child its own group; once bash has exec'd into
      // `sleep`, nothing reaps it, like a container PID 1 that never waits.
      const parent = spawn(
        'bash',
        ['-c', 'set -m; sleep 30 & echo $!; exec sleep 30'],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
      onTestFinished(() => void parent.kill('SIGKILL'))
      const zombie = await new Promise<number>((resolve) =>
        parent.stdout.once('data', (data) => resolve(Number(data))),
      )
      // Until killed below, the child is alive, so its pid cannot be reused.
      let killed = false
      onTestFinished(() => void (killed || process.kill(zombie, 'SIGKILL')))
      // bash would reap a child that exits before the exec.
      await waitFor(
        async () => (await procEntry(parent.pid!, 'comm')) === 'sleep\n',
      )
      process.kill(zombie, 'SIGKILL')
      killed = true
      await waitFor(async () => /\) Z /.test(await procEntry(zombie, 'stat')))
      expect(await groupMemberProbe(zombie)()).toBe(false)
      // `kill` cannot tell this group apart from a running one.
      expect(() => process.kill(-zombie, 0)).not.toThrow()

      const helper = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)",
        ],
        { detached: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
      onTestFinished(() => void helper.kill('SIGKILL'))
      await new Promise((resolve) => helper.stdout.once('data', resolve))
      const helperProbe = groupMemberProbe(helper.pid!)
      expect(await helperProbe()).toBe(true)
      process.kill(-helper.pid!, 'SIGTERM')
      await sleep(200)
      expect(await helperProbe()).toBe(true)
    },
    15_000,
  )
})

function procEntry(pid: number, name: string): Promise<string> {
  return readFile(`/proc/${pid}/${name}`, 'utf8')
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error('Condition not met')
}
