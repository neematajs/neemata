import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'

import type { Definition } from '../../src/graph/index.ts'
import type { Saved } from '../promise-engine.ts'
import { task, workflow } from '../../src/dsl/index.ts'
import {
  canonicalJson,
  captureGraphPresentation,
  describeDefinition,
  hashStructure,
  parseStructure,
  projectStructure,
  renderWorkflowGraph,
  serializeWorkflowGraph,
  structureSlots,
} from '../../src/graph/index.ts'
import { Billing } from '../fixtures/billing.ts'
import { Fulfillment } from '../fixtures/fulfillment.ts'
import { PROMISE_ENGINE } from '../promise-engine.ts'

const text = Schema.String

type Labels = { readonly title?: string; readonly description?: string }

/**
 * One of every node kind, with a task and a child workflow as targets. What
 * the Promise engine saved for it is in `PROMISE_ENGINE.labelled`.
 */
function declare(revision?: string, labels: Labels = {}) {
  const options = { revision, pool: 'graph', input: text, output: text }
  const echo = {
    input: text,
    output: text,
    handler: (value: string) => Effect.succeed(value),
  }
  const items = {
    item: text,
    items: Effect.succeed([]),
    input: (item: string) => Effect.succeed(item),
  }

  const embed = task({
    ...options,
    ...labels,
    ...echo,
    name: 'graph.embed',
  })
  const child = workflow(
    { ...options, ...labels, name: 'graph.child' },
    function* (w) {
      return yield* w.activity('step', { ...echo, from: w.input })
    },
  )
  const parent = workflow(
    { ...options, ...labels, name: 'graph.parent' },
    function* (w) {
      const input = w.input
      yield* w.activity('load', { ...echo, ...labels, from: input })
      yield* w.task('embed', embed, { ...labels, input })
      yield* w.branch('route', {
        ...labels,
        select: Effect.succeed('inline' as const),
        cases: (p) => ({
          viaTask: p.task(embed, { ...labels, input }),
          viaChild: p.workflow(child, { ...labels, input }),
          inline: p.activity({ ...echo, ...labels, from: input }),
        }),
      })
      yield* w.parallel('both', {
        ...labels,
        members: (p) => ({
          left: p.task(embed, { input }),
          right: p.workflow(child, { input }),
        }),
      })
      yield* w.mapTask('each', embed, { ...labels, ...items })
      yield* w.mapWorkflow('eachChild', child, { ...labels, ...items })
      return input
    },
  )

  return { task: embed, child, parent }
}

describe('canonical JSON', () => {
  it('orders object keys by code unit and leaves arrays and strings alone', () => {
    expect(
      canonicalJson({ b: [3, 1, 2], a: { z: null, é: true, e: 'é' }, B: 1 }),
    ).toBe('{"B":1,"a":{"e":"é","z":null,"é":true},"b":[3,1,2]}')
    // Unicode is not normalized: precomposed and decomposed forms stay distinct.
    expect(canonicalJson('é')).not.toBe(canonicalJson('é'))
  })

  it('gives reordered properties one encoding', () => {
    const left = { kind: 'task', name: 'x', formatVersion: 1 }
    const right = { formatVersion: 1, name: 'x', kind: 'task' }

    expect(canonicalJson(left)).toBe(canonicalJson(right))
  })

  it('rejects what JSON would drop or coerce', () => {
    // A hole, not an `undefined` element: JSON would turn it into null.
    const sparse: number[] = []
    sparse[2] = 3

    expect(() => canonicalJson(sparse)).toThrow('sparse array')
    expect(() => canonicalJson({ a: undefined })).toThrow('undefined')
    expect(() => canonicalJson(Number.NaN)).toThrow('non-finite')
    expect(() => canonicalJson(new Date(0))).toThrow('plain objects')
    expect(() => canonicalJson(() => 1)).toThrow('function')
    expect(() => canonicalJson(1n)).toThrow('bigint')
  })
})

describe('structural hash', () => {
  // The bytes and hashes the Promise engine's suite pins for the same graph.
  it('matches golden hashes of the canonical bytes', () => {
    const { task, parent } = declare()
    const structure = projectStructure(parent)

    expect(canonicalJson(projectStructure(task))).toBe(
      '{"formatVersion":1,"kind":"task","name":"graph.embed"}',
    )
    expect(hashStructure(projectStructure(task))).toBe(
      'b9a2f1a3c587d2bd3a31c5ccaa15dc70f4d74c8b8d7662b0ac9c33ae19143715',
    )
    expect(canonicalJson(structure)).toBe(
      '{"formatVersion":1,"kind":"workflow","name":"graph.parent","nodes":[' +
        '{"kind":"activity","name":"load"},' +
        '{"kind":"task","name":"embed","target":{"kind":"task","name":"graph.embed"}},' +
        '{"cases":[' +
        '{"key":"viaTask","kind":"task","target":{"kind":"task","name":"graph.embed"}},' +
        '{"key":"viaChild","kind":"workflow","target":{"kind":"workflow","name":"graph.child"}},' +
        '{"key":"inline","kind":"activity"}' +
        '],"kind":"branch","name":"route"},' +
        '{"cases":[' +
        '{"key":"left","kind":"task","target":{"kind":"task","name":"graph.embed"}},' +
        '{"key":"right","kind":"workflow","target":{"kind":"workflow","name":"graph.child"}}' +
        '],"kind":"parallel","name":"both"},' +
        '{"kind":"mapTask","name":"each","target":{"kind":"task","name":"graph.embed"}},' +
        '{"kind":"mapWorkflow","name":"eachChild","target":{"kind":"workflow","name":"graph.child"}}' +
        ']}',
    )
    expect(hashStructure(structure)).toBe(
      '0226739e42568a5cde12cc62aeba5d012401abd4db06f4e8242a78390bfb6e90',
    )
  })

  it('ignores labels, revisions and policies', () => {
    const plain = describeDefinition(declare().parent)
    const labelled = describeDefinition(
      declare('2026-01', { title: 'Title', description: 'Text' }).parent,
    )
    const step = (retry?: { readonly attempts: number }) =>
      workflow(
        { name: 'graph.step', pool: 'graph', input: text, output: text },
        function* (w) {
          return yield* w.activity('step', {
            input: text,
            output: text,
            from: w.input,
            retry,
            timeout: retry && '5s',
            handler: (value) => Effect.succeed(value),
          })
        },
      )

    expect(labelled.graphHash).toBe(plain.graphHash)
    expect(labelled.structure).toStrictEqual(plain.structure)
    expect(describeDefinition(step({ attempts: 3 })).graphHash).toBe(
      describeDefinition(step()).graphHash,
    )
  })

  it('changes with the order of nodes and of cases', () => {
    const { task } = declare()
    const options = { pool: 'graph', input: text, output: text }
    const build = (order: readonly string[]) =>
      workflow({ ...options, name: 'graph.order' }, function* (w) {
        for (const name of order) {
          yield* w.task(name, task, { input: w.input })
        }
        return w.input
      })
    const branch = (order: readonly ('one' | 'two')[]) =>
      workflow({ ...options, name: 'graph.cases' }, function* (w) {
        return yield* w.branch('route', {
          select: Effect.succeed('one' as const),
          cases: (p) => {
            const member = p.task(task, { input: w.input })
            const [first, second] = order
            // Declared in this order, whatever the keys sort to.
            return { [first!]: member, [second!]: member } as Record<
              'one' | 'two',
              typeof member
            >
          },
        })
      })
    const hash = (definition: Definition) =>
      describeDefinition(definition).graphHash

    expect(hash(build(['a', 'b']))).not.toBe(hash(build(['b', 'a'])))
    expect(hash(branch(['one', 'two']))).not.toBe(hash(branch(['two', 'one'])))
  })

  it('changes with a name, a kind, a target or the format version', () => {
    const { parent } = declare()
    const base = projectStructure(parent)
    if (base.kind !== 'workflow') throw new Error('Expected a workflow')
    const hash = hashStructure(base)
    const [load, embed, ...rest] = base.nodes

    const renamed = { ...base, name: 'graph.other' }
    const renamedNode = {
      ...base,
      nodes: [{ ...load!, name: 'loaded' }, embed!, ...rest],
    }
    const retargeted = {
      ...base,
      nodes: [
        load!,
        { ...embed!, target: { kind: 'task', name: 'graph.other' } as const },
        ...rest,
      ],
    }
    const rekinded = {
      ...base,
      nodes: [load!, { ...embed!, kind: 'mapTask' as const }, ...rest],
    }

    for (const changed of [renamed, renamedNode, retargeted, rekinded]) {
      expect(hashStructure(parseStructure(changed))).not.toBe(hash)
    }
    // A later format must never hash like this one.
    expect(() => parseStructure({ ...base, formatVersion: 2 })).toThrow(
      'unsupported format version',
    )
  })

  it('rejects malformed structures instead of repairing them', () => {
    const { parent } = declare()
    const base = projectStructure(parent)
    if (base.kind !== 'workflow') throw new Error('Expected a workflow')
    const [load, embed] = base.nodes
    const sparse: unknown[] = []
    sparse[1] = embed

    // What it accepts, it returns as it was.
    expect(parseStructure(JSON.parse(JSON.stringify(base)))).toStrictEqual(base)
    expect(() => parseStructure(null)).toThrow('not an object')
    expect(() => parseStructure({ ...base, title: 'x' })).toThrow(
      'unknown field [title]',
    )
    expect(() => parseStructure({ ...base, nodes: sparse })).toThrow('sparse')
    expect(() =>
      parseStructure({ ...base, nodes: [{ ...load, kind: 'loop' }] }),
    ).toThrow('unknown kind [loop]')
    expect(() =>
      parseStructure({ ...base, nodes: [{ name: 'embed', kind: 'task' }] }),
    ).toThrow('target')
    expect(() =>
      parseStructure({ ...base, nodes: [{ ...load, target: embed!.target }] }),
    ).toThrow('activity has a target')
    expect(() => parseStructure({ ...base, nodes: [load, load] })).toThrow(
      'repeated node [load]',
    )
    expect(() =>
      parseStructure({ formatVersion: 1, kind: 'task', name: 't', nodes: [] }),
    ).toThrow('task structure has nodes')
  })
})

describe('graph presentation', () => {
  it('is absent when nothing is labelled', () => {
    const { task, parent } = declare()

    expect(captureGraphPresentation(task)).toBeUndefined()
    expect(captureGraphPresentation(parent)).toBeUndefined()
  })

  it('captures labels by node name and case key, outside the hash', () => {
    const { parent } = declare('v1', { title: 'T', description: 'D' })
    const labels = { title: 'T', description: 'D' }

    expect(captureGraphPresentation(parent)).toStrictEqual({
      ...labels,
      nodes: {
        load: labels,
        embed: { ...labels, target: labels },
        route: {
          ...labels,
          cases: {
            viaTask: { ...labels, target: labels },
            viaChild: { ...labels, target: labels },
            inline: labels,
          },
        },
        both: {
          ...labels,
          cases: { left: { target: labels }, right: { target: labels } },
        },
        each: { ...labels, target: labels },
        eachChild: { ...labels, target: labels },
      },
    })
  })

  it('keeps the labels of a node or a case named `__proto__`', () => {
    const labels = { title: 'T' }
    // By hand: the authoring layer refuses such names, a graph does not.
    const presentation = captureGraphPresentation({
      kind: 'workflow',
      name: 'graph.reserved',
      steps: [
        {
          kind: 'parallel',
          name: '__proto__',
          members: [['__proto__', { kind: 'activity', ...labels }]],
          ...labels,
        },
      ],
    } as unknown as Definition)

    expect(JSON.parse(JSON.stringify(presentation))).toStrictEqual(
      JSON.parse(
        '{"nodes":{"__proto__":{"title":"T","cases":{"__proto__":{"title":"T"}}}}}',
      ),
    )
  })

  it('renders a saved structure with its saved labels as the declared graph', () => {
    const { parent } = declare('v1', { title: 'T', description: 'D' })
    const { structure, presentation } = describeDefinition(parent)
    if (structure.kind !== 'workflow') throw new Error('Expected a workflow')

    expect(renderWorkflowGraph(structure, presentation)).toStrictEqual(
      serializeWorkflowGraph(parent),
    )
    // Without saved labels the graph has names only.
    expect(renderWorkflowGraph(structure)).toStrictEqual(
      serializeWorkflowGraph(declare().parent),
    )
  })
})

describe('what the Promise engine saved for the same declaration', () => {
  /** Everything saved about a definition: the Promise engine's, then ours. */
  function compare(saved: Saved, ours: Definition) {
    const described = describeDefinition(ours)

    // The text that is hashed, byte for byte, and so the hash.
    expect(canonicalJson(described.structure)).toBe(saved.canonical)
    expect(described.graphHash).toBe(saved.graphHash)
    expect(described.structure).toStrictEqual(saved.structure)
    expect(described.presentation).toStrictEqual(saved.presentation)
    expect(described.manifest).toStrictEqual(saved.manifest)
    if (ours.kind === 'workflow') {
      expect(serializeWorkflowGraph(ours)).toStrictEqual(saved.graph)
    }
    return described
  }

  it('is what the documented billing example gives here', () => {
    const old = PROMISE_ENGINE.billing
    const [billing, manual] = Billing.workflows.map((ours, index) =>
      compare(old.workflows[index]!, ours),
    )
    Billing.tasks.forEach((ours, index) => compare(old.tasks[index]!, ours))

    expect(Billing.workflows).toHaveLength(old.workflows.length)
    expect(Billing.tasks).toHaveLength(old.tasks.length)
    expect(billing!.graphHash).toBe(
      '32416e4d5f663dc613dd8413c7a48c46652266808f4af1af4ead58e4e5698cfe',
    )
    expect(manual!.graphHash).not.toBe(billing!.graphHash)
  })

  it('is what the documented fulfillment example gives here', () => {
    const old = PROMISE_ENGINE.fulfillment
    const [fulfillment] = Fulfillment.workflows.map((ours, index) =>
      compare(old.workflows[index]!, ours),
    )
    Fulfillment.tasks.forEach((ours, index) => compare(old.tasks[index]!, ours))

    expect(Fulfillment.workflows).toHaveLength(old.workflows.length)
    expect(Fulfillment.tasks).toHaveLength(old.tasks.length)
    expect(fulfillment!.graphHash).toBe(
      'c477447966ede0604c07b33bc199dab74563ded7f355c699d9ec70ce262d5d20',
    )
  })

  it('is the same with labels and revisions on every node kind', () => {
    const ours = declare('v1', { title: 'T', description: 'D' })

    for (const key of ['task', 'child', 'parent'] as const) {
      const { presentation, manifest } = compare(
        PROMISE_ENGINE.labelled[key],
        ours[key],
      )
      expect(presentation).toBeDefined()
      expect(manifest).toBeDefined()
    }
  })
})

describe('revision manifest', () => {
  it('binds every named target of a versioned workflow to its revision', () => {
    const { task, child, parent } = declare('v1')
    const { structure, graphHash, manifest } = describeDefinition(parent)
    const taskRef = { kind: 'task', name: task.name, revision: 'v1' }
    const childRef = { kind: 'workflow', name: child.name, revision: 'v1' }

    expect(manifest).toStrictEqual({
      kind: 'workflow',
      name: 'graph.parent',
      revision: 'v1',
      graphHash,
      // The cases a run may never take are bound like the one it takes.
      bindings: [
        { nodeName: 'embed', target: taskRef },
        { nodeName: 'route', caseKey: 'viaTask', target: taskRef },
        { nodeName: 'route', caseKey: 'viaChild', target: childRef },
        { nodeName: 'both', caseKey: 'left', target: taskRef },
        { nodeName: 'both', caseKey: 'right', target: childRef },
        { nodeName: 'each', target: taskRef },
        { nodeName: 'eachChild', target: childRef },
      ],
    })
    // One binding per named-target slot of the graph, in the graph's order.
    expect(
      manifest!.bindings.map(({ target: { kind, name }, ...slot }) => ({
        ...slot,
        target: { kind, name },
      })),
    ).toStrictEqual(structureSlots(structure))
  })

  it('binds nothing for a task, and is absent without a revision', () => {
    const { task } = declare('v1')
    const { graphHash, manifest } = describeDefinition(task)

    expect(manifest).toStrictEqual({
      kind: 'task',
      name: 'graph.embed',
      revision: 'v1',
      graphHash,
      bindings: [],
    })
    expect(describeDefinition(declare().task).manifest).toBeUndefined()
    expect(describeDefinition(declare().parent).manifest).toBeUndefined()
  })

  it('keeps a parent graph hash when only a child revision changes', () => {
    function parentOf(taskRevision: string, revision: string) {
      const options = { pool: 'graph', input: text, output: text }
      const work = task({
        ...options,
        name: 'graph.bump.task',
        revision: taskRevision,
        handler: (value) => Effect.succeed(value),
      })
      return workflow(
        { ...options, name: 'graph.bump.parent', revision },
        function* (w) {
          return yield* w.task('work', work, { input: w.input })
        },
      )
    }
    const before = describeDefinition(parentOf('t1', 'p1'))
    const after = describeDefinition(parentOf('t2', 'p2'))

    expect(after.graphHash).toBe(before.graphHash)
    expect(after.manifest?.bindings).not.toStrictEqual(
      before.manifest?.bindings,
    )
  })
})

describe('revisions', () => {
  const options = { pool: 'graph', input: text, output: text }
  const loose = declare()
  const pinned = declare('v1')
  const strict = { ...options, name: 'graph.strict', revision: 'v1' }
  const items = {
    item: text,
    items: Effect.succeed([]),
    input: (item: string) => Effect.succeed(item),
  }

  it('pin a workflow and its program to exact code', () => {
    expect(pinned.parent).toMatchObject({
      name: 'graph.parent',
      revision: 'v1',
    })
    expect(pinned.parent.program).toMatchObject({
      name: 'graph.parent',
      revision: 'v1',
      steps: [
        {},
        { name: 'embed', task: { name: 'graph.embed', revision: 'v1' } },
        {
          cases: {
            viaChild: { workflow: { name: 'graph.child', revision: 'v1' } },
          },
        },
        {},
        { target: { task: { name: 'graph.embed', revision: 'v1' } } },
        { target: { workflow: { name: 'graph.child', revision: 'v1' } } },
      ],
    })
    expect(pinned.task.program).toMatchObject({ kind: 'task', revision: 'v1' })
    // Unversioned is a lane of its own: nothing names a revision there.
    expect(loose.parent.program).not.toHaveProperty('revision')
    expect(loose.task.program).not.toHaveProperty('revision')
  })

  it('refuse a versioned workflow that references an unversioned target', () => {
    expect(() =>
      workflow(strict, function* (w) {
        return yield* w.task('work', loose.task, { input: w.input })
      }),
    ).toThrow(
      'Workflow [graph.strict@v1] node [work] references unversioned task [graph.embed]: every task and child workflow of a versioned workflow must declare a revision',
    )
    expect(() =>
      workflow(strict, function* (w) {
        yield* w.mapWorkflow('each', loose.child, items)
        return w.input
      }),
    ).toThrow('node [each] references unversioned workflow [graph.child]')
    expect(() =>
      workflow(strict, function* (w) {
        yield* w.parallel('both', {
          members: (p) => ({
            pinned: p.task(pinned.task, { input: w.input }),
            loose: p.task(loose.task, { input: w.input }),
          }),
        })
        return w.input
      }),
    ).toThrow('node [both] references unversioned task [graph.embed]')
    expect(() =>
      workflow(strict, function* (w) {
        return yield* w.branch('route', {
          select: Effect.succeed('a' as const),
          cases: (p) => ({ a: p.workflow(loose.child, { input: w.input }) }),
        })
      }),
    ).toThrow('node [route] references unversioned workflow [graph.child]')
  })

  it('let an unversioned workflow use versioned targets', () => {
    const Flow = workflow({ ...options, name: 'graph.free' }, function* (w) {
      return yield* w.task('work', pinned.task, { input: w.input })
    })

    expect(Flow.program.steps).toMatchObject([
      { task: { name: 'graph.embed', revision: 'v1' } },
    ])
    expect(describeDefinition(Flow).manifest).toBeUndefined()
  })

  it('require a revision to be a non-empty string', () => {
    expect(() =>
      task({
        ...options,
        name: 'graph.empty',
        revision: '',
        handler: (value) => Effect.succeed(value),
      }),
    ).toThrow(
      'Invalid task revision [graph.empty]: expected a non-empty string',
    )
    expect(() =>
      workflow(
        { ...options, name: 'graph.empty', revision: '' },
        function* (w) {
          return yield* w.task('work', pinned.task, { input: w.input })
        },
      ),
    ).toThrow(
      'Invalid workflow revision [graph.empty]: expected a non-empty string',
    )
  })
})
