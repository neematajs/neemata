import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import * as Schema from 'effect/Schema'
import { expect, it } from 'vitest'

import { spawnNeem, waitFor } from '../../../neem/tests/e2e/support/e2e.ts'
import { defineTask } from '../../src/index.ts'
import { createWorkflowRuntimeClient } from '../../src/runtime/index.ts'
import {
  createPostgresWorkflowHarness,
  postgresTarget,
  requireServiceEnv,
} from './helpers.ts'

requireServiceEnv(postgresTarget)

it.skipIf(!postgresTarget.url)(
  'recycles an overrun thread and safely reclaims its sibling leases',
  async () => {
    const harness = await createPostgresWorkflowHarness()
    const dir = await mkdtemp(resolve(import.meta.dirname, '../.tmp-recovery-'))
    await cp(resolve(import.meta.dirname, '../fixtures/effect-recovery'), dir, {
      recursive: true,
    })
    const eventsFile = resolve(dir, 'events.jsonl')
    const env = {
      POSTGRES_URL: postgresTarget.url,
      WORKFLOW_EVENTS_FILE: eventsFile,
      WORKFLOW_FAILURE_FILE: resolve(dir, 'failed'),
    }
    const build = spawnNeem(['build'], { cwd: dir, env })
    let server: ReturnType<typeof spawnNeem> | undefined
    try {
      expect(await build.waitForExit(), build.stderr()).toEqual({
        code: 0,
        signal: null,
      })
      const client = createWorkflowRuntimeClient(harness.runtime)
      const tasks = ['timed', 'sibling'].map((name) =>
        defineTask({
          name: `effect-recovery.${name}`,
          input: Schema.Number,
          output: Schema.Number,
          retry: { attempts: 3 },
          ...(name === 'timed' ? { timeout: '300ms' as const } : {}),
        }),
      )
      const runs = await Promise.all(tasks.map((task) => client.start(task, 1)))
      server = spawnNeem(['start'], { cwd: dir, env })
      await server.waitForEvent((event) => event.event === 'runtime:ready')
      await waitFor(
        async () => {
          const snapshots = await Promise.all(
            runs.map((run) => client.get(run.id)),
          )
          return snapshots.every(
            (snapshot) => snapshot?.run.status === 'completed',
          )
        },
        30_000,
        () => server!.stderr(),
      )
      const snapshots = await Promise.all(runs.map((run) => client.get(run.id)))
      for (const snapshot of snapshots) {
        expect(snapshot!.run.output).toBe(2)
        // Lease takeover redelivers the same durable attempt; thread loss does
        // not manufacture a handler failure or consume a business retry.
        expect(snapshot!.attempts).toHaveLength(1)
        expect(snapshot!.attempts[0]!.status).toBe('completed')
      }
      const events = (await readFile(eventsFile, 'utf8'))
        .trim()
        .split('\n')
        .map((line): { event: string; threadId: number } => JSON.parse(line))
      const failedThread = events.find(
        (event) => event.event === 'timed-started',
      )!.threadId
      expect(
        events.find((event) => event.event === 'sibling-started')!.threadId,
      ).toBe(failedThread)
      expect(
        events.some(
          (event) =>
            event.threadId === failedThread && event.event === 'release',
        ),
      ).toBe(false)
      expect(
        events.filter((event) => event.event === 'replacement-completed'),
      ).toHaveLength(2)
      expect(
        events
          .filter((event) => event.event === 'replacement-completed')
          .every((event) => event.threadId !== failedThread),
      ).toBe(true)
      expect(await server.stop()).toEqual({ code: 0, signal: null })
    } finally {
      await build.stop()
      await server?.stop()
      await harness.cleanup()
      await rm(dir, { recursive: true, force: true })
    }
  },
  60_000,
)
