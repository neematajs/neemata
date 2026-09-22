import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import { defineTask, defineWorkflow } from '../src/effect/index.ts'
import {
  defineSchedule,
  defineTask as defineStandardTask,
  defineWorkflow as defineStandardWorkflow,
  implementWorkflow as implementStandardWorkflow,
} from '../src/index.ts'

describe('workflow contract graph', () => {
  const embedding = defineTask({
    name: 'embedding.generate',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
  })

  const fallbackWorkflow = defineWorkflow({
    name: 'fallback-content',
    input: Schema.Struct({ scenario: Schema.String }),
    output: Schema.Struct({ text: Schema.String }),
  }).build()
  const numberTask = defineTask({
    name: 'number-task',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ count: Schema.Number }),
  })
  const numberWorkflow = defineWorkflow({
    name: 'number-workflow',
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ count: Schema.Number }),
  }).build()

  const workflow = defineWorkflow({
    name: 'case-generation',
    input: Schema.Struct({
      kind: Schema.Union([
        Schema.Literal('normal'),
        Schema.Literal('fallback'),
      ]),
      scenario: Schema.String,
    }),
    output: Schema.Struct({ caseId: Schema.String }),
  })
    .activity('content', {
      input: Schema.Struct({ scenario: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
    .task('embedding', embedding)
    .workflow('fallbackContent', fallbackWorkflow)
    .branch('caseContent', {
      output: Schema.Struct({ text: Schema.String }),
      cases: (helpers) => ({
        normal: helpers.activity({
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
        }),
        fallback: helpers.workflow(fallbackWorkflow),
      }),
    })
    .build()

  it('preserves introspectable node metadata', () => {
    const [activityNode, taskNode, childWorkflowNode, branchNode] =
      workflow.nodes

    expect(activityNode.output).toBeDefined()
    expect(taskNode.task).toBe(embedding)
    expect(childWorkflowNode.workflow).toBe(fallbackWorkflow)
    expect(branchNode.output).toBeDefined()
    expect(branchNode.cases.normal.kind).toBe('activity')
    expect(branchNode.cases.fallback.target).toBe(fallbackWorkflow)

    expectTypeOf(taskNode.task).toEqualTypeOf<typeof embedding>()
    expectTypeOf(childWorkflowNode.workflow).toEqualTypeOf<
      typeof fallbackWorkflow
    >()
    expectTypeOf(branchNode.cases.fallback.target).toEqualTypeOf<
      typeof fallbackWorkflow
    >()
  })

  it('preserves declarative presentation metadata on definitions, nodes, and cases', () => {
    const metadataTask = defineTask({
      name: 'metadata-task',
      title: 'Metadata task',
      description: 'Task description',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
    const metadataWorkflow = defineWorkflow({
      name: 'metadata-child',
      title: 'Metadata child workflow',
      description: 'Child workflow description',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    }).build()

    expect(metadataTask.title).toBe('Metadata task')
    expect(metadataTask.description).toBe('Task description')

    const withMetadata = defineWorkflow({
      name: 'metadata-parent',
      title: 'Metadata parent workflow',
      description: 'Parent workflow description',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
      .activity('activityNode', {
        title: 'Activity node',
        description: 'Activity node description',
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
      .task('taskNode', metadataTask, {
        title: 'Task node',
        description: 'Task node description',
      })
      .workflow('workflowNode', metadataWorkflow, {
        title: 'Workflow node',
        description: 'Workflow node description',
      })
      .branch('branchNode', {
        title: 'Branch node',
        description: 'Branch node description',
        output: Schema.Struct({ text: Schema.String }),
        cases: (helpers) => ({
          inline: helpers.activity({
            title: 'Inline case',
            description: 'Inline case description',
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
          }),
          taskCase: helpers.task(metadataTask, {
            title: 'Task case',
            description: 'Task case description',
          }),
          workflowCase: helpers.workflow(metadataWorkflow, {
            title: 'Workflow case',
            description: 'Workflow case description',
          }),
        }),
      })
      .parallel(
        'parallelNode',
        (helpers) => ({
          inline: helpers.activity({
            title: 'Parallel inline case',
            description: 'Parallel inline case description',
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.Struct({ text: Schema.String }),
          }),
          taskCase: helpers.task(metadataTask, {
            title: 'Parallel task case',
            description: 'Parallel task case description',
          }),
          workflowCase: helpers.workflow(metadataWorkflow, {
            title: 'Parallel workflow case',
            description: 'Parallel workflow case description',
          }),
        }),
        {
          title: 'Parallel node',
          description: 'Parallel node description',
        },
      )
      .mapTask('mapTaskNode', metadataTask, {
        title: 'Map task node',
        description: 'Map task node description',
        item: Schema.Struct({ text: Schema.String }),
      })
      .mapWorkflow('mapWorkflowNode', metadataWorkflow, {
        title: 'Map workflow node',
        description: 'Map workflow node description',
        item: Schema.Struct({ text: Schema.String }),
      })
      .build()

    expect(withMetadata.title).toBe('Metadata parent workflow')
    expect(withMetadata.description).toBe('Parent workflow description')
    expect(withMetadata.nodes.map((node) => node.title)).toEqual([
      'Activity node',
      'Task node',
      'Workflow node',
      'Branch node',
      'Parallel node',
      'Map task node',
      'Map workflow node',
    ])
    expect(withMetadata.nodes.map((node) => node.description)).toEqual([
      'Activity node description',
      'Task node description',
      'Workflow node description',
      'Branch node description',
      'Parallel node description',
      'Map task node description',
      'Map workflow node description',
    ])

    const branchNode = withMetadata.nodes[3]
    const parallelNode = withMetadata.nodes[4]

    expect(branchNode.kind).toBe('branch')
    expect(branchNode.cases.inline.title).toBe('Inline case')
    expect(branchNode.cases.inline.description).toBe('Inline case description')
    expect(branchNode.cases.taskCase.title).toBe('Task case')
    expect(branchNode.cases.workflowCase.description).toBe(
      'Workflow case description',
    )

    expect(parallelNode.kind).toBe('parallel')
    expect(parallelNode.cases.inline.title).toBe('Parallel inline case')
    expect(parallelNode.cases.taskCase.description).toBe(
      'Parallel task case description',
    )
    expect(parallelNode.cases.workflowCase.title).toBe('Parallel workflow case')

    const withoutMetadata = defineWorkflow({
      name: 'metadata-free',
      input: Schema.Struct({ text: Schema.String }),
    })
      .activity('plainActivity', {
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
      })
      .parallel('plainParallel', (helpers) => ({
        plainCase: helpers.activity({
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
        }),
      }))
      .build()

    expect('title' in withoutMetadata).toBe(false)
    expect(withoutMetadata.nodes.every((node) => !('title' in node))).toBe(true)

    const plainParallel = withoutMetadata.nodes[1]
    expect(plainParallel.kind).toBe('parallel')
    expect('title' in plainParallel.cases.plainCase).toBe(false)
  })

  it('rejects converged branch task and workflow cases with mismatched outputs', () => {
    defineWorkflow({
      name: 'invalid-converged-branch',
      input: Schema.Struct({ text: Schema.String }),
      output: Schema.Struct({ text: Schema.String }),
    })
      .branch('content', {
        output: Schema.Struct({ text: Schema.String }),
        cases: (helpers) => ({
          // @ts-expect-error task output must match declared branch output
          task: helpers.task(numberTask),
          // @ts-expect-error workflow output must match declared branch output
          workflow: helpers.workflow(numberWorkflow),
        }),
      })
      .build()
  })

  it('defines static schedules for tasks and workflows', () => {
    const schedule = defineSchedule({
      name: 'case-generation-schedule',
      runnable: workflow,
      input: { kind: 'normal', scenario: 'alpha' },
      every: '5m',
      tags: { tenantId: 'tenant-1' },
    })

    expect(schedule).toMatchObject({
      kind: 'schedule',
      name: 'case-generation-schedule',
      runnable: workflow,
      input: { kind: 'normal', scenario: 'alpha' },
      every: '5m',
      tags: { tenantId: 'tenant-1' },
      enabled: true,
    })
  })

  it('rejects schedule definitions without exactly one cadence', () => {
    expect(() =>
      defineSchedule({
        name: 'missing-cadence',
        runnable: workflow,
        input: { kind: 'normal', scenario: 'alpha' },
      }),
    ).toThrow(
      'Schedule [missing-cadence] must define exactly one of cron/every',
    )

    expect(() =>
      defineSchedule({
        name: 'double-cadence',
        runnable: workflow,
        input: { kind: 'normal', scenario: 'alpha' },
        cron: '* * * * *',
        every: '1m',
      }),
    ).toThrow('Schedule [double-cadence] must define exactly one of cron/every')
  })

  it('rejects invalid schedule every durations', () => {
    expect(() =>
      defineSchedule({
        name: 'bad-every',
        runnable: workflow,
        input: { kind: 'normal', scenario: 'alpha' },
        every: '0ms',
      }),
    ).toThrow('Invalid schedule [bad-every] every duration [0ms]')
  })

  it('rejects invalid schedule cron expressions', () => {
    expect(() =>
      defineSchedule({
        name: 'bad-cron',
        runnable: workflow,
        input: { kind: 'normal', scenario: 'alpha' },
        cron: 'not a cron',
      }),
    ).toThrow('Invalid schedule [bad-cron] cron [not a cron]')
  })
})

describe('branch case output comparison', () => {
  const text = z.string()

  it('compares a branch case output with the branch output as a whole', () => {
    const mixedTask = defineStandardTask({
      name: 'branch-output.mixed',
      input: text,
      output: z.union([z.string(), z.number()]),
    })
    const textTask = defineStandardTask({
      name: 'branch-output.text',
      input: text,
      output: text,
    })

    defineStandardWorkflow({ name: 'branch-output.workflow', input: text })
      .branch('choice', {
        output: text,
        cases: (h) => ({
          text: h.task(textTask),
          // @ts-expect-error string | number does not satisfy a string branch
          mixed: h.task(mixedTask),
        }),
      })
      .build()
  })
})

describe('reserved node names', () => {
  const text = z.string()

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects the reserved node name %s',
    (name) => {
      expect(() =>
        defineStandardWorkflow({
          name: 'reserved-node.workflow',
          input: text,
        }).activity(name, { input: text, output: text }),
      ).toThrow(`Workflow node name cannot be "${name}"`)
    },
  )
})

describe('reserved case keys', () => {
  const text = z.string()
  const task = defineStandardTask({
    name: 'reserved-key.member',
    input: text,
    output: text,
  })
  const reserved = ['__proto__', 'constructor', 'prototype']

  it.each(reserved)('rejects the parallel member key %s', (key) => {
    expect(() =>
      defineStandardWorkflow({ name: 'reserved-key.parallel', input: text })
        // A computed key is an own property even when it spells `__proto__`.
        .parallel('pair', (h) => ({ [key]: h.task(task), ok: h.task(task) })),
    ).toThrow(`Workflow parallel member key cannot be "${key}": pair`)
  })

  it.each(reserved)('rejects the branch case key %s', (key) => {
    expect(() =>
      defineStandardWorkflow({
        name: 'reserved-key.branch',
        input: text,
      }).branch('choice', {
        output: text,
        cases: (h) => ({ [key]: h.task(task), ok: h.task(task) }),
      }),
    ).toThrow(`Workflow branch case key cannot be "${key}": choice`)
  })

  it('refuses to implement a hand-built definition with a reserved member key', () => {
    const built = defineStandardWorkflow({
      name: 'reserved-key.implement',
      input: text,
    })
      .parallel('pair', (h) => ({ ok: h.task(task) }))
      .build()
    const [node] = built.nodes
    const member = node.cases.ok
    const workflow = {
      ...built,
      nodes: [{ ...node, cases: { ['__proto__']: member, ok: member } }],
    } as unknown as typeof built

    expect(() =>
      implementStandardWorkflow(workflow, { pool: 'test' }).pair(
        ({ task: run }) =>
          ({ ['__proto__']: run(task), ok: run(task) }) as never,
      ),
    ).toThrow('Workflow parallel case key cannot be "__proto__": pair')
  })
})
