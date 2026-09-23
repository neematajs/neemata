import { PGlite } from '@electric-sql/pglite'
import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  createPostgresWorkflowConnection,
  createPostgresWorkflowRuntime,
} from '../src/adapters/postgres.ts'
import { installPostgresWorkflowSchemaForTesting } from '../src/adapters/postgres/testing.ts'

describe('run timestamps', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('a burst of runs keeps wall-clock timestamps and its creation order', async () => {
    const connection = createPostgresWorkflowConnection(new PGlite())
    await installPostgresWorkflowSchemaForTesting(connection)
    const { store } = createPostgresWorkflowRuntime({ connection })
    const fixed = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(fixed)

    const created: string[] = []
    for (let index = 0; index < 100; index++) {
      const run = await store.createRun({
        workflowName: 'timestamp-burst',
        input: { index },
      })
      expect(run.activeSince).toBe(fixed)
      expect(run.createdAt).toBe(fixed)
      expect(run.updatedAt).toBe(fixed)
      created.push(run.id)
    }

    // A timeout sweep one millisecond later sees every run as due.
    const due = await store.listRuns({
      name: 'timestamp-burst',
      activeBefore: fixed + 1,
    })
    expect(due.runs).toHaveLength(100)

    const newestFirst = created.toReversed()
    const listed: string[] = []
    const summarized: string[] = []
    let cursor: string | undefined
    do {
      const page = await store.listRuns({
        name: 'timestamp-burst',
        limit: 7,
        cursor,
      })
      const summaries = await store.listRunSummaries({
        name: 'timestamp-burst',
        limit: 7,
        cursor,
      })
      listed.push(...page.runs.map((run) => run.id))
      summarized.push(...summaries.runs.map((run) => run.id))
      cursor = page.nextCursor
    } while (cursor)
    expect(listed).toStrictEqual(newestFirst)
    expect(summarized).toStrictEqual(newestFirst)
  })
})
