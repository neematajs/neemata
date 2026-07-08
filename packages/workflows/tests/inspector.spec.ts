import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import type { RunSnapshot, StoredAttempt } from '../src/runtime/state.ts'
import { defineTask, defineWorkflow } from '../src/index.ts'
import {
  serializeWorkflowCatalog,
  serializeWorkflowGraph,
  toAttemptDto,
  toRunSnapshotDto,
} from '../src/inspector/index.ts'

const scoreTask = defineTask({
  name: 'score',
  input: t.object({ text: t.string() }),
  output: t.object({ score: t.number() }),
})

const childWorkflow = defineWorkflow({
  name: 'child',
  input: t.object({ text: t.string() }),
  output: t.object({ text: t.string() }),
}).build()

const workflow = defineWorkflow({
  name: 'everything',
  input: t.object({ text: t.string() }),
  output: t.object({ text: t.string() }),
})
  .activity('extract', {
    input: t.object({ text: t.string() }),
    output: t.object({ text: t.string() }),
  })
  .task('scoring', scoreTask)
  .workflow('enrich', childWorkflow)
  .branch('route', {
    output: t.object({ text: t.string() }),
    cases: (helpers) => ({
      inline: helpers.activity({
        input: t.object({ text: t.string() }),
        output: t.object({ text: t.string() }),
      }),
      delegated: helpers.workflow(childWorkflow),
    }),
  })
  .parallel('fanout', (helpers) => ({
    scored: helpers.task(scoreTask),
    enriched: helpers.workflow(childWorkflow),
  }))
  .mapTask('scoreAll', scoreTask, {
    item: t.object({ text: t.string() }),
    mode: 'wait-all',
  })
  .mapWorkflow('enrichAll', childWorkflow, {
    item: t.object({ text: t.string() }),
    mode: 'wait-settled',
  })
  .build()

describe('serializeWorkflowGraph', () => {
  it('serializes every node kind to the stable JSON shape', () => {
    expect(serializeWorkflowGraph(workflow)).toEqual({
      name: 'everything',
      nodes: [
        { name: 'extract', kind: 'activity' },
        {
          name: 'scoring',
          kind: 'task',
          target: { kind: 'task', name: 'score' },
        },
        {
          name: 'enrich',
          kind: 'workflow',
          target: { kind: 'workflow', name: 'child' },
        },
        {
          name: 'route',
          kind: 'branch',
          cases: [
            { key: 'inline', kind: 'activity' },
            {
              key: 'delegated',
              kind: 'workflow',
              target: { kind: 'workflow', name: 'child' },
            },
          ],
        },
        {
          name: 'fanout',
          kind: 'parallel',
          cases: [
            {
              key: 'scored',
              kind: 'task',
              target: { kind: 'task', name: 'score' },
            },
            {
              key: 'enriched',
              kind: 'workflow',
              target: { kind: 'workflow', name: 'child' },
            },
          ],
        },
        {
          name: 'scoreAll',
          kind: 'mapTask',
          target: { kind: 'task', name: 'score' },
          mode: 'wait-all',
        },
        {
          name: 'enrichAll',
          kind: 'mapWorkflow',
          target: { kind: 'workflow', name: 'child' },
          mode: 'wait-settled',
        },
      ],
    })
  })

  it('survives JSON transport unchanged', () => {
    const graph = serializeWorkflowGraph(workflow)
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph)
  })
})

describe('serializeWorkflowCatalog', () => {
  it('lists definitions with their graphs', () => {
    const catalog = serializeWorkflowCatalog({
      workflows: [workflow, childWorkflow],
      tasks: [scoreTask],
    })

    expect(catalog.workflows.map((graph) => graph.name)).toEqual([
      'everything',
      'child',
    ])
    expect(catalog.workflows[0]).toEqual(serializeWorkflowGraph(workflow))
    expect(catalog.tasks).toEqual([{ name: 'score' }])
  })

  it('defaults missing inputs to empty lists', () => {
    expect(serializeWorkflowCatalog({})).toEqual({ workflows: [], tasks: [] })
  })
})

describe('snapshot DTO mappers', () => {
  const createdAt = new Date('2026-07-08T10:00:00.000Z')
  const updatedAt = new Date('2026-07-08T10:00:01.000Z')

  const snapshot: RunSnapshot = {
    run: {
      id: 'run-1',
      kind: 'workflow',
      name: 'everything',
      workflowName: 'everything',
      status: 'running',
      input: { text: 'hi' },
      rootRunId: 'run-1',
      tags: { env: 'test' },
      version: 3,
      createdAt,
      updatedAt,
    },
    nodes: [
      {
        runId: 'run-1',
        name: 'extract',
        kind: 'activity',
        status: 'completed',
        output: { text: 'hi' },
        version: 2,
        createdAt,
        updatedAt,
      },
    ],
    children: [
      {
        runId: 'run-1',
        nodeName: 'extract',
        childKey: '$self',
        kind: 'activity',
        status: 'completed',
        ordinal: 0,
        output: { text: 'hi' },
        attemptCount: 1,
        version: 2,
        createdAt,
        updatedAt,
      },
    ],
    attempts: [
      {
        id: 'attempt-1',
        runId: 'run-1',
        nodeName: 'extract',
        childKey: '$self',
        status: 'completed',
        attemptNumber: 1,
        input: { text: 'hi' },
        output: { text: 'hi' },
        dispatchedAt: createdAt,
        completedAt: updatedAt,
      },
    ],
  }

  it('converts every Date to an ISO string and round-trips through JSON', () => {
    const dto = toRunSnapshotDto(snapshot)

    expect(dto.run.createdAt).toBe('2026-07-08T10:00:00.000Z')
    expect(dto.nodes[0].updatedAt).toBe('2026-07-08T10:00:01.000Z')
    expect(dto.children[0].createdAt).toBe('2026-07-08T10:00:00.000Z')
    expect(dto.attempts[0].dispatchedAt).toBe('2026-07-08T10:00:00.000Z')
    expect(dto.attempts[0].completedAt).toBe('2026-07-08T10:00:01.000Z')
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto)
  })

  it('keeps optional attempt timestamps optional', () => {
    const attempt: StoredAttempt = {
      id: 'attempt-2',
      runId: 'run-1',
      nodeName: 'extract',
      childKey: '$self',
      status: 'started',
      attemptNumber: 1,
      input: { text: 'hi' },
      dispatchedAt: createdAt,
      heartbeatAt: updatedAt,
    }

    const dto = toAttemptDto(attempt)
    expect(dto.heartbeatAt).toBe('2026-07-08T10:00:01.000Z')
    expect(dto.completedAt).toBeUndefined()
  })
})
