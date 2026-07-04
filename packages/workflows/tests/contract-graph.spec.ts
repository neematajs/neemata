import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { defineSchedule, defineTask, defineWorkflow } from '../src/index.ts'

describe('workflow contract graph', () => {
  const embedding = defineTask({
    name: 'embedding.generate',
    input: t.object({ text: t.string() }),
    output: t.object({ id: t.string() }),
  })

  const fallbackWorkflow = defineWorkflow({
    name: 'fallback-content',
    input: t.object({ scenario: t.string() }),
    output: t.object({ text: t.string() }),
  }).build()
  const numberTask = defineTask({
    name: 'number-task',
    input: t.object({ text: t.string() }),
    output: t.object({ count: t.number() }),
  })
  const numberWorkflow = defineWorkflow({
    name: 'number-workflow',
    input: t.object({ text: t.string() }),
    output: t.object({ count: t.number() }),
  }).build()

  const workflow = defineWorkflow({
    name: 'case-generation',
    input: t.object({
      kind: t.union(t.literal('normal'), t.literal('fallback')),
      scenario: t.string(),
    }),
    output: t.object({ caseId: t.string() }),
  })
    .activity('content', {
      input: t.object({ scenario: t.string() }),
      output: t.object({ text: t.string() }),
    })
    .task('embedding', embedding)
    .workflow('fallbackContent', fallbackWorkflow)
    .branch('caseContent', {
      output: t.object({ text: t.string() }),
      cases: (helpers) => ({
        normal: helpers.activity({
          input: t.object({ text: t.string() }),
          output: t.object({ text: t.string() }),
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

  it('rejects converged branch task and workflow cases with mismatched outputs', () => {
    defineWorkflow({
      name: 'invalid-converged-branch',
      input: t.object({ text: t.string() }),
      output: t.object({ text: t.string() }),
    })
      .branch('content', {
        output: t.object({ text: t.string() }),
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
    ).toThrow('Schedule [missing-cadence] must define exactly one of cron/every')

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
