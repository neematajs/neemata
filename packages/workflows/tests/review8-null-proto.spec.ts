import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type { WorkflowParallelNode } from '../src/types/index.ts'
import {
  decodeOrderedRecord,
  decodeRecord,
} from '../src/adapters/redis/store.ts'
import { defineWorkflow, implementWorkflow } from '../src/index.ts'
import { decodeNodeOutput } from '../src/runtime/codec.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  runExecutionWorker,
  runWorkflowWorker,
} from '../src/runtime/index.ts'

const text = z.string()

describe('parallel output decoding', () => {
  const child = defineWorkflow({
    name: 'review8.schema-less',
    input: text,
  }).build()

  function parallel(key: string): WorkflowParallelNode {
    // Stored or hand-built definitions can bypass the reserved-name builders.
    return {
      kind: 'parallel',
      name: 'pair',
      cases: { [key]: { kind: 'workflow', target: child } },
    }
  }

  it('preserves an own schema-less __proto__ output without a prototype', () => {
    const stored = JSON.parse('{"__proto__":{"value":"kept"}}')
    const output = decodeNodeOutput(parallel('__proto__'), stored)

    expect(Object.getOwnPropertyDescriptor(output, '__proto__')?.value).toEqual(
      {
        value: 'kept',
      },
    )
    expect(Object.getPrototypeOf(output)).toBeNull()
  })

  it('does not restore an inherited constructor for an absent schema-less output', () => {
    const output = decodeNodeOutput(parallel('constructor'), JSON.parse('{}'))

    expect(
      Object.getOwnPropertyDescriptor(output, 'constructor'),
    ).toBeUndefined()
    expect(Object.getOwnPropertyNames(output)).toEqual([])
    expect(Object.getPrototypeOf(output)).toBeNull()
  })
})

describe.each([
  { name: 'decodeRecord', decode: decodeRecord },
  { name: 'decodeOrderedRecord', decode: decodeOrderedRecord },
])('Redis $name', ({ decode }) => {
  it.each([{ keys: ['__proto__'] }, { keys: [] }])(
    'preserves an own __proto__ hash field with ordered keys $keys',
    ({ keys }) => {
      const values = { ['__proto__']: '{"value":"kept"}', ok: '"ok"' }
      const decoded = decode(values, keys)

      expect(Object.hasOwn(decoded, '__proto__')).toBe(true)
      expect(decoded.__proto__).toEqual({ value: 'kept' })
      expect(Object.getPrototypeOf(decoded)).toBeNull()
      expect(decoded.ok).toBe('ok')
      expect(Object.keys(decoded)).toEqual(['__proto__', 'ok'])
    },
  )

  it('ignores inherited hash fields', () => {
    const values: Record<string, string> = Object.create({ inherited: '1' })
    values.own = '2'
    const decoded = decode(values, ['inherited', 'own'])

    expect(Object.keys(decoded)).toEqual(['own'])
    expect(decoded.own).toBe(2)
    expect(Object.getPrototypeOf(decoded)).toBeNull()
  })
})

describe('case normalization', () => {
  it('uses null prototypes for branch and parallel implementations', () => {
    const workflow = defineWorkflow({ name: 'review8.cases', input: text })
      .branch('choice', {
        output: text,
        cases: (h) => ({ ok: h.activity({ input: text, output: text }) }),
      })
      .parallel('pair', (h) => ({
        ok: h.activity({ input: text, output: text }),
      }))
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .choice({ select: () => 'ok', cases: () => ({ ok: (input) => input }) })
      .pair({ ok: (input) => input })
      .finish(({ pair }) => pair)

    for (const node of implementation.nodes) {
      if (node.kind !== 'branch' && node.kind !== 'parallel')
        throw new Error(`Unexpected node kind: ${node.kind}`)
      expect(Object.getPrototypeOf(node.cases)).toBeNull()
      expect(Object.keys(node.cases)).toEqual(['ok'])
    }
  })

  it('requires an own case implementation even for an inherited function name', () => {
    const workflow = defineWorkflow({ name: 'review8.inherited', input: text })
      .parallel('pair', (h) => ({
        toString: h.activity({ input: text, output: text }),
      }))
      .build()

    expect(() =>
      implementWorkflow(workflow, { pool: 'test' }).pair({}),
    ).toThrow('Missing workflow parallel case implementation [pair.toString]')
  })
})

describe('coordinator output dictionaries', () => {
  it('reconstructs completed node outputs without a prototype', async () => {
    const workflow = defineWorkflow({
      name: 'review8.continuation',
      input: text,
      output: text,
    })
      .activity('step', { input: text, output: text })
      .build()
    let outputs: unknown
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .step((input) => input)
      .finish((result) => {
        outputs = result
        return result.step
      })
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    const workers = {
      ...runtime,
      workflows: [implementation],
      tasks: [],
      workerId: 'review8',
    }

    const run = await client.start(workflow, 'hi')
    await runWorkflowWorker(workers)
    await runExecutionWorker(workers)
    await runWorkflowWorker(workers)

    expect((await client.get(run.id))?.run.status).toBe('completed')
    expect(outputs).toEqual({ step: 'hi' })
    expect(Object.getPrototypeOf(outputs)).toBeNull()
  })

  it('persists parallel member outputs without a prototype', async () => {
    const workflow = defineWorkflow({ name: 'review8.parallel', input: text })
      .parallel('pair', (h) => ({
        left: h.activity({ input: text, output: text }),
        right: h.activity({ input: text, output: text }),
      }))
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .pair({ left: (input) => input, right: (input) => input })
      .finish(({ pair }) => pair)
    const runtime = createInMemoryWorkflowRuntime()
    const client = createWorkflowRuntimeClient(runtime)
    let outputs: unknown
    const workers = {
      ...runtime,
      store: {
        ...runtime.store,
        completeNode: async (params) => {
          // Observe the dispatch dictionary before a store can serialize it.
          outputs = params.output
          return runtime.store.completeNode(params)
        },
      },
      workflows: [implementation],
      tasks: [],
      workerId: 'review8',
    }

    const run = await client.start(workflow, 'hi')
    await runWorkflowWorker(workers)
    await runExecutionWorker(workers)
    await runWorkflowWorker(workers)

    expect((await client.get(run.id))?.run.status).toBe('completed')
    expect(outputs).toEqual({ left: 'hi', right: 'hi' })
    expect(Object.getPrototypeOf(outputs)).toBeNull()
  })
})
