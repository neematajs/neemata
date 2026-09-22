import { PGlite } from '@electric-sql/pglite'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
  type WorkflowPostgresConnection,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'
import { defineWorkflow } from '../src/effect/index.ts'
import { defineSchedule } from '../src/index.ts'

type Row = Record<string, unknown>

const createPgliteConnection = (db = new PGlite()) =>
  createPostgresWorkflowConnection(db)

async function rows<T extends Row>(
  connection: WorkflowPostgresConnection,
  sql: string,
  params: readonly unknown[] = [],
) {
  return (await connection.query<T>(sql, params)).rows
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('postgres scheduler', () => {
  test.each(['hello', '123'])(
    'a schedule keeps its string input %j as stored',
    async (input) => {
      const connection = createPgliteConnection()
      await installPostgresWorkflowSchemaForTesting(connection)
      const runtime = createPostgresWorkflowRuntime({ connection })
      const workflow = defineWorkflow({
        name: 'scheduler-string-input',
        input: Schema.String,
      }).build()
      const schedule = defineSchedule({
        name: 'scheduler-string-schedule',
        runnable: workflow,
        input,
        every: '10s',
        immediately: true,
      })
      await runtime.scheduler!.reconcile([schedule])

      expect(
        (await runtime.scheduler!.list()).map((entry) => entry.input),
      ).toEqual([input])
      const triggered = await runtime.scheduler!.trigger(schedule.name)
      expect(triggered.input).toBe(input)
      await expect(runtime.scheduler!.fireDue()).resolves.toStrictEqual({
        fired: 1,
      })
      await expect(
        runtime.scheduler!.setEnabled(schedule.name, false),
      ).resolves.toMatchObject({ input })

      expect(await rows(connection, 'SELECT input FROM workflow_runs')).toEqual(
        [{ input }, { input }],
      )
    },
  )

  test('manual triggers from separate scheduler instances in one millisecond stay distinct', async () => {
    const db = new PGlite()
    const connection = createPgliteConnection(db)
    await installPostgresWorkflowSchemaForTesting(connection)
    const first = createPostgresWorkflowRuntime({ connection })
    const second = createPostgresWorkflowRuntime({
      connection: createPgliteConnection(db),
    })
    const workflow = defineWorkflow({
      name: 'scheduler-manual-trigger',
      input: Schema.Struct({ value: Schema.String }),
    }).build()
    const schedule = defineSchedule({
      name: 'scheduler-manual-schedule',
      runnable: workflow,
      input: { value: 'alpha' },
      every: '10s',
      immediately: true,
    })
    const triggeredAt = Date.UTC(2026, 0, 1)
    vi.spyOn(Date, 'now').mockReturnValue(triggeredAt)
    await first.scheduler!.reconcile([schedule])

    const left = await first.scheduler!.trigger(schedule.name)
    const right = await second.scheduler!.trigger(schedule.name)
    expect(right.id).not.toBe(left.id)
    expect((await first.scheduler!.list())[0]?.lastSlotAt).toBe(triggeredAt)

    // a recurring fire keeps its slot identity, so instances still agree on it
    await expect(second.scheduler!.fireDue()).resolves.toStrictEqual({
      fired: 1,
    })
    const fired = await rows<{ idempotency_key: unknown }>(
      connection,
      'SELECT idempotency_key FROM workflow_runs WHERE id <> ALL($1::uuid[])',
      [[left.id, right.id]],
    )
    expect(fired).toEqual([
      { idempotency_key: ['$schedule', schedule.name, triggeredAt] },
    ])
    expect((await first.scheduler!.list())[0]?.lastSlotAt).toBe(triggeredAt)
  })
})
