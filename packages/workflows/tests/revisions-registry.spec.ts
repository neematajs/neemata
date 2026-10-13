import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type { WorkflowStore } from '../src/runtime/index.ts'
import { task, workflow } from '../src/experimental/index.ts'
import {
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import { describeDefinition, refKey } from '../src/runtime/definition.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  verifyWorkflowsRegistry,
  WorkflowDefinitionConflictError,
} from '../src/runtime/index.ts'
import { createWorkflowRuntimeRegistry } from '../src/runtime/registry.ts'
import { settle } from './support/experimental.ts'

const text = z.string()

function family(revision?: string, taskRevision = revision) {
  const leaf = defineTask({
    name: 'registry.leaf',
    revision: taskRevision,
    input: text,
    output: text,
  })
  const leafImplementation = implementTask(leaf, {
    pool: 'test',
    handler: async (input) => input,
  })
  const parent = defineWorkflow({
    name: 'registry.parent',
    revision,
    input: text,
    output: text,
  })
    .task('work', leaf)
    .build()
  const parentImplementation = implementWorkflow(parent, { pool: 'test' })
    .work(leaf)
    .finish(({ work }) => work)

  return { leaf, leafImplementation, parent, parentImplementation }
}

describe('registry lookups by revision', () => {
  it('holds several revisions of one name and resolves each exactly', () => {
    const legacy = family()
    const v1 = family('v1')
    const v2 = family('v2')
    const registry = createWorkflowRuntimeRegistry({
      workflows: [
        legacy.parentImplementation,
        v1.parentImplementation,
        v2.parentImplementation,
      ],
      tasks: [
        legacy.leafImplementation,
        v1.leafImplementation,
        v2.leafImplementation,
      ],
    })

    expect(registry.getWorkflow('registry.parent')).toBe(
      legacy.parentImplementation,
    )
    expect(registry.getWorkflow('registry.parent', 'v1')).toBe(
      v1.parentImplementation,
    )
    expect(registry.getTask('registry.leaf', 'v2')).toBe(v2.leafImplementation)
    // An absent or unknown revision never falls back to another one.
    expect(registry.getWorkflow('registry.parent', 'v3')).toBeUndefined()
    expect(
      createWorkflowRuntimeRegistry({
        workflows: [v1.parentImplementation],
      }).getWorkflow('registry.parent'),
    ).toBeUndefined()
  })

  it('rejects two implementations of one revision', () => {
    const v1 = family('v1')

    expect(() =>
      createWorkflowRuntimeRegistry({
        workflows: [v1.parentImplementation, family('v1').parentImplementation],
      }),
    ).toThrow('Duplicate workflow implementation [registry.parent@v1]')
  })

  it('keeps names that look like a joined name and revision apart', () => {
    const joined = defineTask({ name: 'a@b', input: text, output: text })
    const split = defineTask({
      name: 'a',
      revision: 'b',
      input: text,
      output: text,
    })
    const options = { pool: 'test', handler: async (input: string) => input }
    const joinedImplementation = implementTask(joined, options)
    const splitImplementation = implementTask(split, options)
    const registry = createWorkflowRuntimeRegistry({
      tasks: [joinedImplementation, splitImplementation],
    })

    expect(registry.getTask('a@b')).toBe(joinedImplementation)
    expect(registry.getTask('a', 'b')).toBe(splitImplementation)
    expect(refKey(joined)).not.toBe(refKey(split))
  })

  it('reports the exact revision a workflow cannot route to', () => {
    const v1 = family('v1')
    const v2 = family('v2')
    const registry = createWorkflowRuntimeRegistry({
      workflows: [v1.parentImplementation],
      tasks: [v2.leafImplementation],
    })

    expect(
      registry.validateRouteability(v1.parentImplementation),
    ).toStrictEqual(['task:registry.leaf@v1'])
  })
})

describe('registry verification with revisions', () => {
  it('accepts several complete revisions of one name', () => {
    const generations = [family(), family('v1'), family('v2')]

    expect(() =>
      verifyWorkflowsRegistry({
        workflows: generations.map((entry) => entry.parentImplementation),
        tasks: generations.map((entry) => entry.leafImplementation),
        schedules: [
          defineSchedule({
            name: 'registry.nightly',
            runnable: generations[1]!.parent,
            input: 'x',
            every: '1h',
          }),
        ],
      }),
    ).not.toThrow()
  })

  it('rejects a revision whose task is served only as another revision', () => {
    const v1 = family('v1')
    const v2 = family('v2')

    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [v1.parentImplementation, v2.parentImplementation],
        tasks: [v2.leafImplementation],
      }),
    ).toThrow(
      'Tasks [registry.leaf@v1] referenced by registered workflows have no registered implementation',
    )
  })

  it('rejects a revision registered twice', () => {
    const v1 = family('v1')

    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [v1.parentImplementation, family('v1').parentImplementation],
        tasks: [v1.leafImplementation],
      }),
    ).toThrow(
      'Implementations [workflow:registry.parent@v1] are registered more than once',
    )
  })

  it('rejects a schedule whose target revision is not served', () => {
    const v1 = family('v1')
    const v2 = family('v2')

    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [v1.parentImplementation],
        tasks: [v1.leafImplementation],
        schedules: [
          defineSchedule({
            name: 'registry.nightly',
            runnable: v2.parent,
            input: 'x',
            every: '1h',
          }),
        ],
      }),
    ).toThrow(
      '[registry.parent@v2] targeted by schedules have no registered implementation',
    )
  })
})

describe('inspection of a damaged saved graph', () => {
  async function started() {
    const { parent } = family('v1')
    const runtime = createInMemoryWorkflowRuntime()
    const run = await createWorkflowRuntimeClient(runtime).start(parent, 'x')
    // The client knows the deployed definition and must never fall back to it.
    const inspect = (store: Partial<WorkflowStore>) =>
      createWorkflowRuntimeClient({
        ...runtime,
        store: { ...runtime.store, ...store },
        definitions: [parent],
      })

    return { parent, run, inspect }
  }

  it('reports a missing graph instead of the deployed definition', async () => {
    const { run, inspect } = await started()
    const client = inspect({ loadGraph: async () => undefined })

    expect(await client.inspect(run.id)).toMatchObject({
      detail: { run: { id: run.id } },
      definition: { source: 'observed', reason: 'missing-graph' },
    })
  })

  it('reports a graph that no longer hashes to its key', async () => {
    const { parent, run, inspect } = await started()
    const { structure, graphHash } = describeDefinition(parent)
    const tampered = { ...structure, name: 'registry.other' }
    const client = inspect({
      loadGraph: async () => ({ graphHash, structure: tampered }),
    })

    expect((await client.inspect(run.id))!.definition).toStrictEqual({
      source: 'observed',
      reason: 'invalid-graph',
    })
    await expect(
      client.getDefinition({
        kind: 'workflow',
        name: parent.name,
        revision: 'v1',
      }),
    ).rejects.toThrow(WorkflowDefinitionConflictError)
  })

  it('reports a record that is not a structure at all', async () => {
    const { run, inspect } = await started()
    const client = inspect({
      loadGraph: async (graphHash) => ({
        graphHash,
        structure: { nodes: 'gone' } as never,
      }),
    })

    expect((await client.inspect(run.id))!.definition).toStrictEqual({
      source: 'observed',
      reason: 'invalid-graph',
    })
  })

  it('omits bindings that belong to another graph', async () => {
    const { parent, run, inspect } = await started()
    const { manifest } = describeDefinition(parent)
    const client = inspect({
      loadRevision: async () => ({ ...manifest!, graphHash: 'f'.repeat(64) }),
    })

    const { definition } = (await client.inspect(run.id))!
    expect(definition.source).toBe('saved')
    expect(definition).not.toHaveProperty('revision')
  })
})

describe('experimental authoring with revisions', () => {
  const Text = Schema.String

  function author(revision: string) {
    const Shout = task({
      name: 'registry.experimental.shout',
      revision,
      pool: 'test',
      input: Text,
      output: Text,
      handler: (input) => Effect.succeed(`${input}!@${revision}`),
    })
    const Root = workflow(
      {
        name: 'registry.experimental.root',
        revision,
        pool: 'test',
        input: Text,
        output: Text,
      },
      function* (w) {
        return yield* w.task('shout', Shout, { input: w.input })
      },
    )

    return { Shout, Root }
  }

  it('carries the revision onto the generated contracts', () => {
    const { Shout, Root } = author('v1')

    expect(Shout.contract.revision).toBe('v1')
    expect(Root.contract.revision).toBe('v1')
    expect(describeDefinition(Root.contract).manifest?.bindings).toStrictEqual([
      {
        nodeName: 'shout',
        target: { kind: 'task', name: Shout.contract.name, revision: 'v1' },
      },
    ])
  })

  it('refuses a versioned workflow that uses an unversioned task', () => {
    const Loose = task({
      name: 'registry.experimental.loose',
      pool: 'test',
      input: Text,
      output: Text,
      handler: (input) => Effect.succeed(input),
    })

    expect(() =>
      workflow(
        {
          name: 'registry.experimental.strict',
          revision: 'v1',
          pool: 'test',
          input: Text,
          output: Text,
        },
        function* (w) {
          return yield* w.task('loose', Loose, { input: w.input })
        },
      ),
    ).toThrow('references unversioned task [registry.experimental.loose]')
  })

  it('runs each revision with its own code side by side', async () => {
    const v1 = author('v1')
    const v2 = author('v2')
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const served = {
      workflows: [v1.Root.implementation, v2.Root.implementation],
      tasks: [v1.Shout.implementation, v2.Shout.implementation],
    }

    const older = await client.start(v1.Root.contract, 'hi')
    const newer = await client.start(v2.Root.contract, 'hi')

    expect((await settle(older.id, served, runtime)).run.output).toBe('hi!@v1')
    expect((await settle(newer.id, served, runtime)).run.output).toBe('hi!@v2')
  })
})
