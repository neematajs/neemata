import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import { expect, it } from 'vitest'

import {
  spawnNeem,
  wait,
  waitFor,
} from '../../../neem/tests/e2e/support/e2e.ts'
import * as workflows from '../../src/index.ts'
import { createWorkflowRuntimeClient } from '../../src/runtime/index.ts'
import { generation } from '../fixtures/revisions-neem/generations.ts'
import {
  createPostgresWorkflowHarness,
  postgresTarget,
  requireServiceEnv,
} from './helpers.ts'

requireServiceEnv(postgresTarget)

type Event = {
  readonly step: string
  readonly revision: string
  readonly servedBy: string
}

// Leases in the fixture's planner last 600 ms.
const leaseExpiryMs = 1_500

it.skipIf(!postgresTarget.url)(
  'routes each revision to its own pool across deployments and a crash',
  async () => {
    const harness = await createPostgresWorkflowHarness()
    const dir = await mkdtemp(
      resolve(import.meta.dirname, '../.tmp-revisions-'),
    )
    await cp(resolve(import.meta.dirname, '../fixtures/revisions-neem'), dir, {
      recursive: true,
    })
    const eventsFile = resolve(dir, 'events.jsonl')
    const prefix = `revisions-neem.${randomUUID().slice(0, 8)}`
    const env = {
      POSTGRES_URL: postgresTarget.url,
      WORKFLOW_EVENTS_FILE: eventsFile,
      WORKFLOW_HANG_FILE: resolve(dir, 'hung'),
      WORKFLOW_PREFIX: prefix,
    }
    // Handlers never run in this process: only the contracts are used here.
    const hooks = { record() {}, gate: async () => {} }
    const v1 = generation(workflows, prefix, 'v1', 'io', hooks)
    const v2 = generation(workflows, prefix, 'v2', 'heavy', hooks)
    const client = createWorkflowRuntimeClient(harness.runtime)

    const status = async (runId: string) =>
      (await client.get(runId))!.run.status
    const completed = (runIds: readonly string[], server: Deployment) =>
      waitFor(
        async () => {
          const statuses = await Promise.all(runIds.map(status))
          return statuses.every((status) => status === 'completed')
        },
        30_000,
        () => `${server.stdout()}\n${server.stderr()}`,
      )
    type Deployment = ReturnType<typeof spawnNeem>
    async function deployed(revisions: string): Promise<Deployment> {
      const server = spawnNeem(['start'], {
        cwd: dir,
        env: { ...env, WORKFLOW_DEPLOYED: revisions },
      })
      await server.waitForEvent((event) => event.event === 'runtime:ready')
      return server
    }
    async function events(): Promise<Event[]> {
      const lines = (await readFile(eventsFile, 'utf8')).trim().split('\n')
      return lines.map((line): Event => JSON.parse(line))
    }

    const build = spawnNeem(['build'], {
      cwd: dir,
      env: { ...env, WORKFLOW_DEPLOYED: 'v1,v2' },
    })
    try {
      expect(await build.waitForExit(), build.stderr()).toEqual({
        code: 0,
        signal: null,
      })

      // Deployment 1 serves v2 only: v1 work waits, untouched.
      const parked = await client.start(v1.parent, 'x')
      let server = await deployed('v2')
      const current = await client.start(v2.parent, 'x')
      await completed([current.id], server)
      await wait(leaseExpiryMs)
      expect(await status(parked.id)).toBe('queued')
      expect(await client.listDeadCommands({ runId: parked.id })).toHaveLength(
        0,
      )
      expect(await server.stop({ killAfterMs: 10_000 })).toEqual({
        code: 0,
        signal: null,
      })

      // Deployment 2 serves both: the parked v1 run resumes on v1 code.
      server = await deployed('v1,v2')
      await completed([parked.id], server)
      expect((await client.get(parked.id))!.run.output).toStrictEqual([
        'x|first@v1',
        'x|task@v1',
        'x|child@v1',
      ])
      for (const { run } of await client.getFamily(parked.id)) {
        expect(run.executionRevision).toBe('v1')
      }

      // A v1 activity hangs and the whole process is killed under it.
      const crashed = await client.start(v1.parent, 'hang')
      await waitFor(
        () => existsSync(env.WORKFLOW_HANG_FILE),
        30_000,
        () => server.stderr(),
      )
      server.child.kill('SIGKILL')
      await server.waitForExit()

      // Deployment 3 lost v1 again: the expired lease is not taken over by
      // workers that cannot run the attempt, and nothing is dead-lettered.
      server = await deployed('v2')
      await wait(leaseExpiryMs)
      expect(await status(crashed.id)).toBe('running')
      expect(await client.listDeadCommands({ runId: crashed.id })).toHaveLength(
        0,
      )
      expect(await server.stop({ killAfterMs: 10_000 })).toEqual({
        code: 0,
        signal: null,
      })

      // Deployment 4 restores v1: the same attempt is redelivered and finishes.
      server = await deployed('v1,v2')
      await completed([crashed.id], server)
      const recovered = (await client.get(crashed.id))!
      expect(recovered.run.output).toStrictEqual([
        'hang|first@v1',
        'hang|task@v1',
        'hang|child@v1',
      ])
      expect(recovered.attempts).toMatchObject([{ status: 'completed' }])
      expect(await server.stop({ killAfterMs: 10_000 })).toEqual({
        code: 0,
        signal: null,
      })

      // Every handler ran on the pool its revision was implemented for.
      const handled = await events()
      expect(new Set(handled.map(({ revision }) => revision))).toEqual(
        new Set(['v1', 'v2']),
      )
      for (const { revision, servedBy } of handled) {
        expect(servedBy).toBe(revision === 'v1' ? 'io' : 'heavy')
      }
    } finally {
      await build.stop()
      await harness.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  },
  180_000,
)
