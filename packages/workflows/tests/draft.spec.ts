import { describe, expect, it } from 'vitest'

import type {
  StoredAttempt,
  StoredChild,
  StoredNode,
  StoredRun,
} from '../src/model.ts'
import type { Draft } from '../src/plan/draft.ts'
import type { NodeWithoutInput, Snapshot, UnitRead } from '../src/store.ts'
import { planning } from '../src/plan/draft.ts'
import { unitKey } from '../src/store.ts'

const run: StoredRun = {
  id: 'run-1',
  kind: 'task',
  name: 'charge',
  status: 'failed',
  input: 1,
  rootRunId: 'run-0',
  parentRunId: 'run-0',
  tags: {},
  version: 3,
  activeSince: 0,
  createdAt: 0,
  updatedAt: 0,
}

/** A snapshot that holds the run's record and nothing the run owns. */
function headOnly(): Snapshot {
  return {
    now: 10,
    id: (prefix) => `${prefix}-new`,
    runs: new Map(),
    heads: new Map([[run.id, run]]),
    units: new Map(),
    open: new Map(),
    childResults: new Map(),
    keys: new Map(),
    definitions: new Map(),
    schedules: new Map(),
    scheduleNames: undefined,
    families: new Map(),
    dead: new Map(),
  }
}

describe('a draft', () => {
  it('asks for what a run owns when it was given the run alone, written or not', () => {
    // Writing the record does not load the node, child and attempts under it:
    // a plan that then read "everything the run owns" would find nothing, and
    // decide as if the run had never begun.
    const plan = planning((draft) => {
      draft.updateRun(draft.head(run.id)!, { status: 'queued' })
      return draft.records(run.id)
    })

    expect(plan(headOnly())).toStrictEqual({
      _tag: 'Need',
      scope: { runs: [run.id] },
    })
  })

  it('knows what a run it created owns without asking', () => {
    const plan = planning((draft) => {
      const created = draft.createRun({
        id: 'run-2',
        kind: 'workflow',
        name: 'order',
        input: 1,
        rootRunId: 'run-2',
      })
      draft.createNode({
        runId: created.id,
        name: 'price',
        kind: 'activity',
        status: 'running',
      })
      return draft.records(created.id)?.nodes.map(({ name }) => name)
    })

    expect(plan(headOnly())).toMatchObject({
      _tag: 'Commit',
      result: ['price'],
    })
  })
})

describe('a draft of a unit', () => {
  const node: StoredNode = {
    runId: run.id,
    name: 'charge',
    kind: 'activity',
    status: 'running',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
  const attempt: StoredAttempt = {
    id: 'attempt-1',
    runId: run.id,
    nodeName: node.name,
    childKey: '$self',
    status: 'started',
    attemptNumber: 1,
    retryAttemptNumber: 1,
    input: 1,
    dispatchedAt: 0,
  }
  const child: StoredChild = {
    runId: run.id,
    nodeName: node.name,
    childKey: '$self',
    kind: 'activity',
    status: 'running',
    currentAttemptId: attempt.id,
    attemptCount: 1,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
  const unit: UnitRead = {
    runId: run.id,
    nodeName: node.name,
    childKey: '$self',
    attemptId: attempt.id,
  }
  /** The unit as loaded, and a unit of another child, loaded and absent. */
  const missing: UnitRead = { ...unit, childKey: 'item:0', attemptId: 'gone' }
  const loaded = (): Snapshot => ({
    ...headOnly(),
    heads: new Map(),
    units: new Map([
      [unitKey(unit), { run, node, child, attempt }],
      [unitKey(missing), { run, node, child: undefined, attempt: undefined }],
    ]),
  })

  it('tells what it did not read from what is absent', () => {
    const read = (body: (draft: Draft) => unknown) => planning(body)(loaded())

    // Read, found or absent.
    expect(read((draft) => draft.child(run.id, node.name, 'item:0'))).toEqual({
      _tag: 'Commit',
      mutation: expect.anything(),
      result: undefined,
    })
    expect(read((draft) => draft.unit(missing))).toMatchObject({
      result: { run, node, child: undefined, attempt: undefined },
    })
    // Not read: the run may well hold them, and the plan asks.
    expect(read((draft) => draft.child(run.id, node.name, 'item:1'))).toEqual({
      _tag: 'Need',
      scope: {
        units: [{ runId: run.id, nodeName: node.name, childKey: 'item:1' }],
      },
    })
    expect(read((draft) => draft.node(run.id, 'other'))).toEqual({
      _tag: 'Need',
      scope: { runs: [run.id] },
    })
    // An attempt the unit did not find is absent from its child alone.
    expect(read((draft) => draft.attempt(run.id, 'gone'))).toEqual({
      _tag: 'Need',
      scope: { runs: [run.id] },
    })
    expect(
      read((draft) => draft.unit({ ...unit, attemptId: 'other' })),
    ).toEqual({
      _tag: 'Need',
      scope: { units: [{ ...unit, attemptId: 'other' }] },
    })
    expect(read((draft) => draft.records(run.id))).toEqual({
      _tag: 'Need',
      scope: { runs: [run.id] },
    })
  })

  it('writes what the unit found, and adds attempts only of its own making', () => {
    const write = (body: (draft: Draft) => unknown) => planning(body)(loaded())
    const retried = (draft: Draft, id: string) =>
      draft.createAttempt({ ...attempt, id, attemptNumber: 2 })

    const planned = write((draft) => {
      const found = draft.unit(unit)
      draft.updateAttempt(found.attempt!, { status: 'failed' })
      const successor = retried(draft, draft.id('attempt'))
      draft.updateChild(found.child!, { currentAttemptId: successor.id })
      // Read back as the plan left it.
      const { currentAttemptId } = draft.unit(unit).child!
      return draft.attempt(run.id, currentAttemptId!)
    })
    expect(planned).toMatchObject({
      _tag: 'Commit',
      result: { id: 'attempt-new', attemptNumber: 2 },
      mutation: {
        children: [{ currentAttemptId: 'attempt-new' }],
        attempts: [
          { id: attempt.id, status: 'failed' },
          { id: 'attempt-new', status: 'started' },
        ],
      },
    })

    // Writing what was not read is the plan's mistake, not a need.
    expect(() => write((draft) => retried(draft, 'attempt-2'))).toThrow(
      'Attempt [attempt-2] added to a child the plan did not load',
    )
    expect(() =>
      write((draft) => draft.createChild({ ...child, childKey: 'item:0' })),
    ).toThrow(
      `Created child [charge.item:0] in run [${run.id}] not loaded whole`,
    )
    expect(() =>
      write((draft) => draft.updateChild({ ...child, childKey: 'item:1' }, {})),
    ).toThrow('without reading it')
  })
})

describe('a draft of a unit, moved by the plan', () => {
  const node: StoredNode = {
    runId: run.id,
    name: 'charge',
    kind: 'activity',
    status: 'running',
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
  const attempt = (id: string, attemptNumber: number): StoredAttempt => ({
    id,
    runId: run.id,
    nodeName: node.name,
    childKey: '$self',
    status: 'started',
    attemptNumber,
    retryAttemptNumber: attemptNumber,
    input: 1,
    dispatchedAt: 0,
  })
  const first = attempt('attempt-1', 1)
  const earlier = attempt('attempt-0', 0)
  const child: StoredChild = {
    runId: run.id,
    nodeName: node.name,
    childKey: '$self',
    kind: 'activity',
    status: 'running',
    currentAttemptId: first.id,
    attemptCount: 1,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  }
  const current: UnitRead = {
    runId: run.id,
    nodeName: node.name,
    childKey: '$self',
  }
  const named: UnitRead = { ...current, attemptId: first.id }
  const loaded = (
    ...units: (readonly [UnitRead, StoredAttempt | undefined])[]
  ): Snapshot => ({
    ...headOnly(),
    heads: new Map(),
    units: new Map(
      units.map(([read, found]) => [
        unitKey(read),
        { run, node, child, attempt: found },
      ]),
    ),
  })

  it('reads the successor it made as the unit’s attempt, without asking', () => {
    const plan = planning((draft) => {
      const found = draft.unit(named)
      const successor = draft.createAttempt({
        ...first,
        id: draft.id('attempt'),
        attemptNumber: 2,
      })
      draft.updateChild(found.child!, { currentAttemptId: successor.id })
      return [
        draft.unit({ ...named, attemptId: successor.id }).attempt?.id,
        draft.unit(current).attempt?.id,
      ]
    })

    expect(plan(loaded([named, first]))).toMatchObject({
      _tag: 'Commit',
      result: ['attempt-new', 'attempt-new'],
    })
  })

  it('asks for the attempt its child was moved to, by its id', () => {
    const plan = planning((draft) => {
      const found = draft.unit(current)
      draft.updateChild(found.child!, { currentAttemptId: earlier.id })
      return draft.unit(current).attempt
    })
    const moved = { ...current, attemptId: earlier.id }

    // The current one read was another: this one is not known to be absent.
    expect(plan(loaded([current, first]))).toStrictEqual({
      _tag: 'Need',
      scope: { units: [moved] },
    })
    expect(plan(loaded([current, first], [moved, earlier]))).toMatchObject({
      _tag: 'Commit',
      result: earlier,
    })
    // Found absent under the child, it is absent.
    expect(plan(loaded([current, first], [moved, undefined]))).toMatchObject({
      _tag: 'Commit',
      result: undefined,
    })
  })

  it('writes a run only when it read its record, and never makes one again', () => {
    const family = {
      root: { ...run, id: run.rootRunId, rootRunId: run.rootRunId },
      size: 2,
      active: 0,
    }
    const read = (body: (draft: Draft) => unknown) =>
      planning(body)({
        ...headOnly(),
        heads: new Map(),
        families: new Map([[family.root.id, family]]),
      })

    expect(() =>
      read((draft) => draft.updateRun(run, { status: 'queued' })),
    ).toThrow(`Wrote run [${run.id}] without reading it`)
    // A family's root is guarded, and not read: made, it would be replaced.
    expect(() =>
      read((draft) =>
        draft.createRun({ ...family.root, kind: 'workflow', input: 1 }),
      ),
    ).toThrow(`Created run [${run.rootRunId}], which exists`)
  })
})

describe('a draft of a run opened', () => {
  const workflow: StoredRun = { ...run, kind: 'workflow', status: 'running' }
  const record = {
    runId: run.id,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
  } as const
  const items: StoredNode = {
    ...record,
    name: 'items',
    kind: 'mapTask',
    status: 'running',
    input: [1, 2, 3, 4],
  }
  const { input: _, ...each } = items
  const both: StoredNode = {
    ...record,
    name: 'both',
    kind: 'parallel',
    status: 'running',
  }
  const item = (ordinal: number, status: StoredChild['status']) =>
    ({
      ...record,
      nodeName: each.name,
      childKey: `item:${ordinal}`,
      kind: 'task',
      status,
      ordinal,
      item: ordinal + 1,
      attemptCount: 0,
    }) satisfies StoredChild
  const member: StoredChild = {
    ...record,
    nodeName: both.name,
    childKey: 'member:a',
    kind: 'activity',
    status: 'running',
    currentAttemptId: 'attempt-a',
    attemptCount: 1,
  }
  // The run of a child under way, and one that is not there.
  const linked: StoredRun = { ...run, id: 'run-9', parentRunId: run.id }
  // Of four items, the first is done, the second under way, and the window
  // of one waiting holds the third.
  const opened = (): Snapshot => ({
    ...headOnly(),
    heads: new Map(),
    open: new Map([
      [
        run.id,
        {
          run: workflow,
          nodes: [
            { view: 'withoutInput', record: each },
            { view: 'full', record: both },
          ],
          childSets: new Map([
            [
              each.name,
              {
                view: 'map',
                active: [item(1, 'waiting')],
                pending: [item(2, 'pending')],
                pendingLimit: 1,
                hasMore: true,
              },
            ],
            [both.name, { view: 'all', children: [member] }],
          ]),
          attempts: [],
          linked: new Map([
            [linked.id, linked],
            ['run-gone', undefined],
          ]),
        },
      ],
    ]),
  })
  const read = (body: (draft: Draft) => unknown) => planning(body)(opened())

  it('tells what it did not read from what is absent', () => {
    // Every node was read: one not there is absent, a map's without input.
    expect(read((draft) => draft.nodes(run.id))).toMatchObject({
      result: [each, both],
    })
    expect(read((draft) => draft.node(run.id, 'none'))).toMatchObject({
      _tag: 'Commit',
      result: undefined,
    })
    expect(read((draft) => draft.node(run.id, each.name))).toEqual({
      _tag: 'Need',
      scope: { runs: [run.id] },
    })
    // All of a parallel node's children were read; of a map, a window.
    expect(
      read((draft) => draft.child(run.id, both.name, 'member:b')),
    ).toMatchObject({ _tag: 'Commit', result: undefined })
    expect(read((draft) => draft.child(run.id, each.name, 'item:3'))).toEqual({
      _tag: 'Need',
      scope: {
        units: [{ runId: run.id, nodeName: each.name, childKey: 'item:3' }],
      },
    })
    // The current attempt of a child read was read with it, found or not.
    expect(read((draft) => draft.attempt(run.id, 'attempt-a'))).toMatchObject({
      _tag: 'Commit',
      result: undefined,
    })
    expect(read((draft) => draft.attempt(run.id, 'attempt-0'))).toEqual({
      _tag: 'Need',
      scope: { runs: [run.id] },
    })
    // A window too small is read again, larger; what ends one is not.
    expect(read((draft) => draft.work(run.id, each.name, 1))).toMatchObject({
      result: {
        active: [item(1, 'waiting')],
        pending: [item(2, 'pending')],
        hasMore: true,
      },
    })
    expect(read((draft) => draft.work(run.id, each.name, 2))).toEqual({
      _tag: 'Need',
      scope: {
        open: [
          { runId: run.id, maps: [{ nodeName: each.name, pendingLimit: 2 }] },
        ],
      },
    })
    expect(read((draft) => draft.results(run.id, each.name))).toEqual({
      _tag: 'Need',
      scope: { childResults: [{ runId: run.id, nodeName: each.name }] },
    })
    // The runs of the children read are read with them, found or absent.
    expect(
      read((draft) => {
        draft.require({ heads: [linked.id, 'run-gone'] })
        return [draft.head(linked.id), draft.head('run-gone')]
      }),
    ).toMatchObject({ _tag: 'Commit', result: [linked, undefined] })
    expect(read((draft) => draft.head('run-8'))).toEqual({
      _tag: 'Need',
      scope: { heads: ['run-8'] },
    })
    // A unit is read from the open read where that read all of it: its
    // record whole, and its child and current attempt.
    const memberUnit = {
      runId: run.id,
      nodeName: both.name,
      childKey: member.childKey,
    }
    expect(read((draft) => draft.unit(memberUnit))).toMatchObject({
      _tag: 'Commit',
      result: { run: workflow, node: both, child: member, attempt: undefined },
    })
    // A child past the window, or a node read without its input, is not.
    for (const unit of [
      { runId: run.id, nodeName: each.name, childKey: 'item:3' },
      { runId: run.id, nodeName: each.name, childKey: 'item:1' },
    ]) {
      expect(read((draft) => draft.unit(unit))).toEqual({
        _tag: 'Need',
        scope: { units: [unit] },
      })
    }
  })

  it('sees its own writes in a window, and drops them all when it needs more', () => {
    const planned = read((draft) => {
      const [first] = draft.work(run.id, each.name, 1).pending
      draft.updateChild(first!, { status: 'waiting' })
      const after = draft.work(run.id, each.name, 1)
      return { active: after.active.length, pending: after.pending.length }
    })
    expect(planned).toMatchObject({ result: { active: 2, pending: 0 } })

    expect(
      read((draft) => {
        const [first] = draft.work(run.id, each.name, 1).pending
        draft.updateChild(first!, { status: 'waiting' })
        draft.enqueue({ kind: 'continueRun', runId: run.id, name: 'flow' })
        return draft.work(run.id, each.name, 2)
      }),
    ).toEqual({
      _tag: 'Need',
      scope: {
        open: [
          { runId: run.id, maps: [{ nodeName: each.name, pendingLimit: 2 }] },
        ],
      },
    })
  })

  it('writes a map but for its input, and never over what lies past its window', () => {
    const planned = read((draft) =>
      draft.updateNodeKeepingInput(each, { status: 'waiting' }),
    )
    expect(planned).toMatchObject({
      _tag: 'Commit',
      mutation: {
        nodes: [],
        nodesPreservingInput: [
          { ...each, status: 'waiting', version: 2, updatedAt: 10 },
        ],
      },
    })
    expect(
      planned._tag === 'Commit' && planned.mutation.nodesPreservingInput?.[0],
    ).not.toHaveProperty('input')

    // Read whole, then written whole: one write, with its input.
    expect(
      read((draft) => {
        const kept = draft.updateNodeKeepingInput(both, { status: 'waiting' })
        draft.updateNode(draft.node(run.id, both.name)!, {
          status: kept.status,
        })
      }),
    ).toMatchObject({
      mutation: {
        nodes: [{ name: both.name, version: 3 }],
        nodesPreservingInput: [],
      },
    })

    // An input not read is neither written nor written over, which the
    // types say and the draft holds to whatever got past them.
    const unset: Partial<NodeWithoutInput> = JSON.parse('{"input":null}')
    expect(() =>
      read((draft) => draft.updateNodeKeepingInput(each, unset)),
    ).toThrow('which is kept')
    expect(() =>
      read((draft) => draft.updateNode(items, { status: 'waiting' })),
    ).toThrow('without reading its input')
    // A window is not all of a map's children: one of the key may wait past it.
    expect(() =>
      read((draft) => draft.createChild(item(9, 'pending'))),
    ).toThrow('not loaded whole')

    // A node no read found is made, with its children.
    expect(
      read((draft) => {
        draft.createNode({ ...each, name: 'fresh', input: [] })
        draft.createChild({ ...item(0, 'pending'), nodeName: 'fresh' })
        draft.createChild({ ...member, childKey: 'member:b' })
      }),
    ).toMatchObject({
      _tag: 'Commit',
      mutation: { nodes: [{ name: 'fresh' }], children: [{}, {}] },
    })
  })

  it('gives a node that is absent a child only when it makes the node', () => {
    const ghost = { ...item(0, 'pending'), nodeName: 'ghost' }
    expect(() => read((draft) => draft.createChild(ghost))).toThrow(
      'of a node that is absent',
    )
    // Made after its children, as a map's node is, it has them.
    expect(
      read((draft) => {
        draft.createChild(ghost)
        draft.createNode({ ...each, name: 'ghost', input: [1] })
      }),
    ).toMatchObject({
      _tag: 'Commit',
      mutation: {
        nodes: [{ name: 'ghost' }],
        children: [{ nodeName: 'ghost' }],
      },
    })
  })
})
