import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import type {
  RunSnapshot,
  StoredAttempt,
  StoredNode,
  StoredNodeChild,
} from '../src/runtime/state.ts'
import type {
  AttemptSummary,
  NodeChildSummary,
  NodeSnapshot,
  NodeSummary,
  RunDetail,
  RunFamilyEntry,
  RunSummary,
} from '../src/runtime/store.ts'
import { defineTask, defineWorkflow } from '../src/index.ts'
import {
  nodeUnits,
  serializeWorkflowCatalog,
  serializeWorkflowGraph,
  toAttemptDto,
  toNodeSnapshotDto,
  toNodeUnitDto,
  toRunDetailDto,
  toRunFamilyEntryDto,
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

  it('passes stored errors through untouched', () => {
    const attempt: StoredAttempt = {
      id: 'attempt-3',
      runId: 'run-1',
      nodeName: 'extract',
      childKey: '$self',
      status: 'failed',
      attemptNumber: 2,
      input: { text: 'hi' },
      error: {
        name: 'Error',
        message: 'boom',
        stack: 'Error: boom',
        cause: { message: 'root cause' },
      },
      dispatchedAt: createdAt,
      completedAt: updatedAt,
    }

    const dto = toAttemptDto(attempt)
    expect(dto.error).toEqual(attempt.error)
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto)
  })
})

describe('read model inspector helpers', () => {
  const createdAt = new Date('2026-07-08T10:00:00.000Z')
  const updatedAt = new Date('2026-07-08T10:00:01.000Z')

  const runSummary = (id: string): RunSummary => ({
    id,
    kind: 'workflow',
    name: id,
    workflowName: id,
    status: 'running',
    rootRunId: 'run-1',
    tags: {},
    version: 1,
    createdAt,
    updatedAt,
    nodesTotal: 0,
    nodesCompleted: 0,
  })
  const nodeSummary = (
    name: string,
    kind: NodeSummary['kind'],
  ): NodeSummary => ({
    runId: 'run-1',
    name,
    kind,
    status: 'running',
    version: 1,
    createdAt,
    updatedAt,
  })
  const childSummary = (
    nodeName: string,
    childKey: string,
    ordinal: number,
    childRunId?: string,
  ): NodeChildSummary => ({
    runId: 'run-1',
    nodeName,
    childKey,
    kind: childRunId ? 'workflow' : 'activity',
    status: 'running',
    ordinal,
    ...(childRunId === undefined ? {} : { childRunId }),
    attemptCount: 1,
    version: 1,
    createdAt,
    updatedAt,
  })
  const attemptSummary = (
    childKey: string,
    attemptNumber: number,
  ): AttemptSummary => ({
    id: `attempt-${childKey}-${attemptNumber}`,
    runId: 'run-1',
    nodeName: 'fanout',
    childKey,
    status: 'completed',
    attemptNumber,
    dispatchedAt: createdAt,
    completedAt: updatedAt,
  })

  const detail: RunDetail = {
    run: runSummary('run-1'),
    nodes: [
      nodeSummary('route', 'branch'),
      nodeSummary('fanout', 'parallel'),
      nodeSummary('items', 'mapTask'),
    ],
    children: [
      childSummary('route', 'case:delegated', 0, 'child-1'),
      childSummary('fanout', 'member:b', 0),
      childSummary('fanout', 'member:a', 0),
      childSummary('items', 'item:1', 1),
      childSummary('items', 'item:0', 0),
    ],
    attempts: [
      attemptSummary('member:a', 2),
      attemptSummary('member:a', 1),
      attemptSummary('member:b', 1),
    ],
    childRuns: [runSummary('child-1')],
  }

  it('builds node units for branch, parallel, and map child keys', () => {
    const route = nodeUnits(detail, 'route')
    const fanout = nodeUnits(detail, 'fanout')
    const items = nodeUnits(detail, 'items')

    expect(route).toMatchObject([
      {
        key: 'case:delegated',
        parsed: { kind: 'case', caseKey: 'delegated' },
        childRun: { id: 'child-1' },
      },
    ])
    expect(fanout.map((unit) => unit.key)).toStrictEqual([
      'member:a',
      'member:b',
    ])
    expect(fanout[0]?.parsed).toStrictEqual({
      kind: 'member',
      memberKey: 'a',
    })
    expect(
      fanout[0]?.attempts.map((attempt) => attempt.attemptNumber),
    ).toStrictEqual([1, 2])
    expect(items.map((unit) => unit.parsed)).toStrictEqual([
      { kind: 'item', itemIndex: 0 },
      { kind: 'item', itemIndex: 1 },
    ])
  })

  it('maps new read models to wire-safe DTOs', () => {
    const node: StoredNode = {
      runId: 'run-1',
      name: 'fanout',
      kind: 'parallel',
      status: 'completed',
      input: { text: 'input' },
      output: { text: 'output' },
      version: 2,
      createdAt,
      updatedAt,
    }
    const child: StoredNodeChild = {
      runId: 'run-1',
      nodeName: 'fanout',
      childKey: 'member:a',
      kind: 'activity',
      status: 'completed',
      ordinal: 0,
      input: { text: 'child-input' },
      output: { text: 'child-output' },
      attemptCount: 1,
      version: 2,
      createdAt,
      updatedAt,
    }
    const attempt: StoredAttempt = {
      id: 'attempt-1',
      runId: 'run-1',
      nodeName: 'fanout',
      childKey: 'member:a',
      status: 'completed',
      attemptNumber: 1,
      input: { text: 'attempt-input' },
      output: { text: 'attempt-output' },
      dispatchedAt: createdAt,
      completedAt: updatedAt,
    }
    const snapshot: NodeSnapshot = {
      node,
      children: [child],
      attempts: [attempt],
    }
    const familyEntry: RunFamilyEntry = {
      run: detail.childRuns[0]!,
      origin: { nodeName: 'route', childKey: 'case:delegated' },
    }
    const unit = nodeUnits(detail, 'route')[0]!

    const detailDto = toRunDetailDto(detail)
    const snapshotDto = toNodeSnapshotDto(snapshot)
    const familyDto = toRunFamilyEntryDto(familyEntry)
    const unitDto = toNodeUnitDto(unit)

    expect(detailDto.run.createdAt).toBe('2026-07-08T10:00:00.000Z')
    expect(detailDto.children[0]?.updatedAt).toBe('2026-07-08T10:00:01.000Z')
    expect(snapshotDto.node.output).toStrictEqual({ text: 'output' })
    expect(snapshotDto.attempts[0]?.completedAt).toBe(
      '2026-07-08T10:00:01.000Z',
    )
    expect(familyDto.run.createdAt).toBe('2026-07-08T10:00:00.000Z')
    expect(unitDto.childRun?.updatedAt).toBe('2026-07-08T10:00:01.000Z')
    expect(JSON.parse(JSON.stringify(detailDto))).toEqual(detailDto)
    expect(JSON.parse(JSON.stringify(snapshotDto))).toEqual(snapshotDto)
    expect(JSON.parse(JSON.stringify(familyDto))).toEqual(familyDto)
    expect(JSON.parse(JSON.stringify(unitDto))).toEqual(unitDto)
  })
})
