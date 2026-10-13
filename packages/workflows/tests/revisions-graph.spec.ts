import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type { DefinitionBundle } from '../src/inspector/index.ts'
import { defineTask, defineWorkflow } from '../src/index.ts'
import {
  canonicalJson,
  captureGraphPresentation,
  parseStructure,
  projectStructure,
  renderWorkflowGraph,
  serializeWorkflowGraph,
} from '../src/inspector/index.ts'
import {
  collectBundle,
  describeDefinition,
  hashStructure,
  prepareBundle,
  runDefinitionInput,
} from '../src/runtime/definition.ts'
import { WorkflowDefinitionConflictError } from '../src/runtime/index.ts'

const text = z.string()

type Labels = { readonly title?: string; readonly description?: string }

function declare(revision?: string, labels: Labels = {}) {
  const task = defineTask({
    name: 'graph.embed',
    revision,
    input: text,
    output: text,
    ...labels,
  })
  const child = defineWorkflow({
    name: 'graph.child',
    revision,
    input: text,
    output: text,
    ...labels,
  })
    .activity('step', { input: text, output: text })
    .build()
  const parent = defineWorkflow({
    name: 'graph.parent',
    revision,
    input: text,
    output: text,
    ...labels,
  })
    .activity('load', { input: text, output: text, ...labels })
    .task('embed', task, labels)
    .branch('route', {
      output: text,
      ...labels,
      cases: (helpers) => ({
        viaTask: helpers.task(task, labels),
        viaChild: helpers.workflow(child, labels),
        inline: helpers.activity({ input: text, output: text, ...labels }),
      }),
    })
    .parallel(
      'both',
      (helpers) => ({
        left: helpers.task(task),
        right: helpers.workflow(child),
      }),
      labels,
    )
    .mapTask('each', task, { item: text, ...labels })
    .mapWorkflow('eachChild', child, { item: text, ...labels })
    .build()

  return { task, child, parent }
}

describe('canonical JSON', () => {
  it('orders object keys by code unit and leaves arrays and strings alone', () => {
    expect(
      canonicalJson({ b: [3, 1, 2], a: { z: null, é: true, e: 'é' }, B: 1 }),
    ).toBe('{"B":1,"a":{"e":"é","z":null,"é":true},"b":[3,1,2]}')
    // Unicode is not normalized: precomposed and decomposed forms stay distinct.
    expect(canonicalJson('\u00e9')).not.toBe(canonicalJson('e\u0301'))
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

  it('ignores labels and revisions', () => {
    const plain = describeDefinition(declare().parent)
    const labelled = describeDefinition(
      declare('2026-01', { title: 'Title', description: 'Text' }).parent,
    )

    expect(labelled.graphHash).toBe(plain.graphHash)
    expect(labelled.structure).toStrictEqual(plain.structure)
  })

  it('changes with the order of nodes and of cases', () => {
    const { task } = declare()
    function build(order: 'forward' | 'reverse') {
      const builder = defineWorkflow({
        name: 'graph.order',
        input: text,
        output: text,
      })
      const activity = { input: text, output: text }
      return order === 'forward'
        ? builder.activity('a', activity).activity('b', activity).build()
        : builder.activity('b', activity).activity('a', activity).build()
    }
    function branch(order: 'forward' | 'reverse') {
      return defineWorkflow({ name: 'graph.cases', input: text, output: text })
        .branch('route', {
          cases: (helpers) =>
            order === 'forward'
              ? { one: helpers.task(task), two: helpers.task(task) }
              : { two: helpers.task(task), one: helpers.task(task) },
        })
        .build()
    }
    const hash = (definition: Parameters<typeof describeDefinition>[0]) =>
      describeDefinition(definition).graphHash

    expect(hash(build('forward'))).not.toBe(hash(build('reverse')))
    expect(hash(branch('forward'))).not.toBe(hash(branch('reverse')))
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

  it('renders a saved structure with its saved labels as the catalog graph', () => {
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

describe('definition bundle', () => {
  it('binds every named target of a versioned workflow to its revision', () => {
    const { task, child, parent } = declare('v1')
    const { manifest } = describeDefinition(parent)
    const taskRef = { kind: 'task', name: task.name, revision: 'v1' }
    const childRef = { kind: 'workflow', name: child.name, revision: 'v1' }

    expect(manifest?.bindings).toStrictEqual([
      { nodeName: 'embed', target: taskRef },
      { nodeName: 'route', caseKey: 'viaTask', target: taskRef },
      { nodeName: 'route', caseKey: 'viaChild', target: childRef },
      { nodeName: 'both', caseKey: 'left', target: taskRef },
      { nodeName: 'both', caseKey: 'right', target: childRef },
      { nodeName: 'each', target: taskRef },
      { nodeName: 'eachChild', target: childRef },
    ])
  })

  it('collects the whole reachable closure of a versioned root', () => {
    const { task, child, parent } = declare('v1')
    const bundle = collectBundle(parent)
    const names = bundle.revisions.map(({ kind, name }) => `${kind}:${name}`)

    expect(names.toSorted()).toStrictEqual([
      `task:${task.name}`,
      `workflow:${child.name}`,
      `workflow:${parent.name}`,
    ])
    expect(bundle.graphs).toHaveLength(3)
    expect(() => prepareBundle(bundle)).not.toThrow()
  })

  it('saves only its own graph for an unversioned root', () => {
    const { parent } = declare()
    const { graphHash, definitions, executionRevision } =
      runDefinitionInput(parent)

    expect(executionRevision).toBeUndefined()
    expect(definitions).toStrictEqual({
      graphs: [{ graphHash, structure: projectStructure(parent) }],
      revisions: [],
    })
  })

  it('keeps a parent graph hash when only a child revision changes', () => {
    function parentOf(taskRevision: string, revision: string) {
      const task = defineTask({
        name: 'graph.bump.task',
        revision: taskRevision,
        input: text,
        output: text,
      })
      return defineWorkflow({
        name: 'graph.bump.parent',
        revision,
        input: text,
        output: text,
      })
        .task('work', task)
        .build()
    }
    const before = describeDefinition(parentOf('t1', 'p1'))
    const after = describeDefinition(parentOf('t2', 'p2'))

    expect(after.graphHash).toBe(before.graphHash)
    expect(after.manifest?.bindings).not.toStrictEqual(
      before.manifest?.bindings,
    )
  })

  it('refuses a versioned workflow that references an unversioned target', () => {
    const task = defineTask({ name: 'graph.loose', input: text, output: text })
    const child = defineWorkflow({
      name: 'graph.loose.child',
      input: text,
    }).build()
    const versioned = () =>
      defineWorkflow({ name: 'graph.strict', revision: 'v1', input: text })

    expect(() => versioned().task('work', task)).toThrow(
      'Workflow [graph.strict@v1] node [work] references unversioned task [graph.loose]',
    )
    expect(() =>
      versioned().mapWorkflow('each', child, { item: text }),
    ).toThrow('references unversioned workflow [graph.loose.child]')
    expect(() =>
      versioned().parallel('both', (helpers) => ({ a: helpers.task(task) })),
    ).toThrow('references unversioned task [graph.loose]')
    expect(() =>
      versioned().branch('route', {
        cases: (helpers) => ({ a: helpers.workflow(child) }),
      }),
    ).toThrow('references unversioned workflow [graph.loose.child]')
  })

  it('requires a revision to be a non-empty string', () => {
    expect(() =>
      defineTask({
        name: 'graph.empty',
        revision: '',
        input: text,
        output: text,
      }),
    ).toThrow('Invalid task revision [graph.empty]')
    expect(() =>
      defineWorkflow({ name: 'graph.empty', revision: '', input: text }),
    ).toThrow('Invalid workflow revision [graph.empty]')
  })

  it('refuses two definitions of one revision with different bindings', () => {
    const task = (revision: string) =>
      defineTask({
        name: 'graph.dup.task',
        revision,
        input: text,
        output: text,
      })
    const child = (taskRevision: string) =>
      defineWorkflow({
        name: 'graph.dup.child',
        revision: 'c1',
        input: text,
        output: text,
      })
        .task('work', task(taskRevision))
        .build()
    const parent = defineWorkflow({
      name: 'graph.dup.parent',
      revision: 'p1',
      input: text,
      output: text,
    })
      .workflow('first', child('t1'))
      .workflow('second', child('t2'))
      .build()

    expect(() => collectBundle(parent)).toThrow(WorkflowDefinitionConflictError)
  })
})

describe('bundle validation at the adapter boundary', () => {
  function bundleOf(): DefinitionBundle {
    return structuredClone(collectBundle(declare('v1').parent))
  }

  it('orders records deterministically', () => {
    const { graphs, revisions } = prepareBundle(bundleOf())

    expect(graphs.map(({ graphHash }) => graphHash)).toStrictEqual(
      graphs.map(({ graphHash }) => graphHash).toSorted(),
    )
    expect(revisions.map(({ key }) => key)).toStrictEqual(
      revisions.map(({ key }) => key).toSorted(),
    )
  })

  it('rejects a graph whose content does not hash to its key', () => {
    const bundle = bundleOf()
    const [first, ...rest] = bundle.graphs
    const forged = { ...first!, structure: rest[0]!.structure }

    expect(() =>
      prepareBundle({ ...bundle, graphs: [forged, ...rest] }),
    ).toThrow('does not hash to its key')
  })

  it('rejects a manifest that does not bind what its graph declares', () => {
    const bundle = bundleOf()
    const revisions = bundle.revisions.map((manifest) =>
      manifest.name === 'graph.parent'
        ? { ...manifest, bindings: manifest.bindings.slice(1) }
        : manifest,
    )

    expect(() => prepareBundle({ ...bundle, revisions })).toThrow(
      'Bindings of workflow [graph.parent@v1] do not match the targets of its graph',
    )
  })

  it('rejects a bundle that is not closed over its bindings', () => {
    const bundle = bundleOf()
    const revisions = bundle.revisions.filter(({ kind }) => kind !== 'task')

    expect(() => prepareBundle({ ...bundle, revisions })).toThrow(
      'Bundle lacks task [graph.embed@v1]',
    )
  })

  it('returns fresh records the caller cannot reach', () => {
    const bundle = bundleOf()
    const prepared = prepareBundle(bundle)
    const parent = prepared.graphs.find(
      ({ structure }) => structure.name === 'graph.parent',
    )!
    const { json } = parent
    const source = bundle.graphs.find(
      ({ graphHash }) => graphHash === parent.graphHash,
    )!

    ;(source.structure as { name: string }).name = 'mutated'

    expect(parent.structure.name).toBe('graph.parent')
    expect(canonicalJson(parent.structure)).toBe(json)
  })
})
