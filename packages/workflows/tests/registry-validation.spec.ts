import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import { implementTask, implementWorkflow } from '../src/implement/index.ts'
import { defineSchedule, defineTask, defineWorkflow } from '../src/index.ts'
import {
  createInMemoryWorkflowRuntime,
  runWorkflowWorker,
  verifyWorkflowsRegistry,
} from '../src/runtime/index.ts'

const io = { input: z.object({}), output: z.object({}) }

describe('schedule targets in registry validation', () => {
  const target = defineWorkflow({ name: 'registry.target', ...io }).build()
  const targetImpl = implementWorkflow(target, { pool: 'test' }).finish(
    () => ({}),
  )
  const task = defineTask({ name: 'registry.target-task', ...io })
  const taskImpl = implementTask(task, { pool: 'test', handler: () => ({}) })
  const every = { input: {}, every: '1h' } as const

  it('accepts schedules whose targets are registered', () => {
    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [targetImpl],
        tasks: [taskImpl],
        schedules: [
          defineSchedule({ name: 'workflow', runnable: target, ...every }),
          defineSchedule({ name: 'task', runnable: task, ...every }),
        ],
      }),
    ).not.toThrow()
  })

  it('rejects a schedule whose task or workflow has no implementation', () => {
    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [targetImpl],
        schedules: [defineSchedule({ name: 'task', runnable: task, ...every })],
      }),
    ).toThrow(
      `[${task.name}] targeted by schedules have no registered implementation`,
    )
    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [],
        tasks: [taskImpl],
        schedules: [
          defineSchedule({ name: 'workflow', runnable: target, ...every }),
        ],
      }),
    ).toThrow(
      `[${target.name}] targeted by schedules have no registered implementation`,
    )
  })

  it('rejects a schedule targeting a same-named copy of a registered definition', () => {
    const taskCopy = defineTask({ name: task.name, ...io })
    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [targetImpl],
        tasks: [taskImpl],
        schedules: [
          defineSchedule({ name: 'task', runnable: taskCopy, ...every }),
        ],
      }),
    ).toThrow(`Definitions [${task.name}] exist as more than one`)
    const targetCopy = defineWorkflow({ name: target.name, ...io }).build()
    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [targetImpl],
        schedules: [
          defineSchedule({ name: 'copy', runnable: targetCopy, ...every }),
        ],
      }),
    ).toThrow(`Definitions [${target.name}] exist as more than one`)
  })
})

describe('duplicate implementations in registry validation', () => {
  const workflow = defineWorkflow({
    name: 'registry.duplicate-workflow',
    ...io,
  }).build()
  const implement = () =>
    implementWorkflow(workflow, { pool: 'test' }).finish(() => ({}))
  const task = defineTask({ name: 'registry.duplicate-task', ...io })
  const implementDuplicateTask = () =>
    implementTask(task, { pool: 'test', handler: () => ({}) })

  it('rejects two implementations of one workflow', () => {
    expect(() =>
      verifyWorkflowsRegistry({ workflows: [implement(), implement()] }),
    ).toThrow(
      `Implementations [workflow:${workflow.name}] are registered more than once`,
    )
  })

  it('rejects two implementations of one task', () => {
    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [implement()],
        tasks: [implementDuplicateTask(), implementDuplicateTask()],
      }),
    ).toThrow(
      `Implementations [task:${task.name}] are registered more than once`,
    )
  })

  // The execution registry refuses it at claim time as well; only the Neem
  // worker deduplicates the lists it collects from modules.
  it('rejects one implementation listed twice', () => {
    const implementation = implement()
    expect(() =>
      verifyWorkflowsRegistry({ workflows: [implementation, implementation] }),
    ).toThrow(`Implementations [workflow:${workflow.name}]`)
  })
})

describe('references in registry validation', () => {
  const task = defineTask({ name: 'registry.referenced-task', ...io })
  const taskImpl = implementTask(task, { pool: 'test', handler: () => ({}) })
  const child = defineWorkflow({ name: 'registry.child', ...io }).build()
  const childImpl = implementWorkflow(child, { pool: 'test' }).finish(
    () => ({}),
  )
  const parent = defineWorkflow({ name: 'registry.parent', ...io })
    .workflow('child', child)
    .task('work', task)
    .build()
  const parentImpl = implementWorkflow(parent, { pool: 'test' })
    .child(child, { input: (_outputs, input) => input })
    .work(task, { input: (_outputs, input) => input })
    .finish(() => ({}))

  it('accepts workflows whose children and tasks are registered', () => {
    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [parentImpl, childImpl],
        tasks: [taskImpl],
      }),
    ).not.toThrow()
  })

  it('rejects child workflows without a registered implementation', () => {
    expect(() =>
      verifyWorkflowsRegistry({ workflows: [parentImpl], tasks: [taskImpl] }),
    ).toThrow(
      `Workflows [${child.name}] referenced by registered workflows have no registered implementation`,
    )
  })

  it('rejects workflow tasks without a registered implementation', () => {
    expect(() =>
      verifyWorkflowsRegistry({ workflows: [parentImpl, childImpl] }),
    ).toThrow(
      `Tasks [${task.name}] referenced by registered workflows have no registered implementation`,
    )
  })

  it('rejects a name carried by more than one definition object', () => {
    // Definitions cannot reference each other as objects, so a same-named copy
    // is the only way to close a cycle; it would also decode with another schema.
    const aCopy = defineWorkflow({ name: 'registry.cycle.a', ...io }).build()
    const b = defineWorkflow({ name: 'registry.cycle.b', ...io })
      .workflow('next', aCopy)
      .build()
    const a = defineWorkflow({ name: 'registry.cycle.a', ...io })
      .workflow('next', b)
      .build()
    const aImpl = implementWorkflow(a, { pool: 'test' })
      .next(b, { input: (_outputs, input) => input })
      .finish(() => ({}))
    const bImpl = implementWorkflow(b, { pool: 'test' })
      .next(aCopy, { input: (_outputs, input) => input })
      .finish(() => ({}))
    expect(() =>
      verifyWorkflowsRegistry({ workflows: [aImpl, bImpl] }),
    ).toThrow(`Definitions [${a.name}] exist as more than one object`)

    const taskCopy = defineTask({ name: task.name, ...io })
    const copyParent = defineWorkflow({ name: 'registry.task-copy', ...io })
      .task('work', taskCopy)
      .build()
    const copyParentImpl = implementWorkflow(copyParent, { pool: 'test' })
      .work(taskCopy, { input: (_outputs, input) => input })
      .finish(() => ({}))
    expect(() =>
      verifyWorkflowsRegistry({
        workflows: [copyParentImpl],
        tasks: [taskImpl],
      }),
    ).toThrow(`Definitions [${task.name}] exist as more than one`)
  })
})

describe('execution pools in registry validation', () => {
  const workflow = defineWorkflow({ name: 'registry.pooled', ...io }).build()
  const workflowImpl = implementWorkflow(workflow, { pool: 'light' }).finish(
    () => ({}),
  )
  const task = defineTask({ name: 'registry.pooled-task', ...io })
  const taskImpl = implementTask(task, { pool: 'heavy', handler: () => ({}) })
  const registry = { workflows: [workflowImpl], tasks: [taskImpl] }

  it('rejects an implementation that names an undeclared pool', () => {
    expect(() =>
      verifyWorkflowsRegistry({ ...registry, pools: ['light', 'heavvy'] }),
    ).toThrow(
      'Execution pools [heavy] named by implementations are not declared',
    )
    expect(() =>
      verifyWorkflowsRegistry({ ...registry, pools: ['light', 'heavy'] }),
    ).not.toThrow()
  })

  it('skips the pool check when no pools are declared', () => {
    expect(() => verifyWorkflowsRegistry(registry)).not.toThrow()
  })
})

describe('standalone workers without registry validation', () => {
  it('runs a workflow worker whose tasks are registered elsewhere', async () => {
    const task = defineTask({ name: 'registry.remote-task', ...io })
    const workflow = defineWorkflow({ name: 'registry.partial', ...io })
      .task('work', task)
      .build()
    const implementation = implementWorkflow(workflow, { pool: 'test' })
      .work(task, { input: (_outputs, input) => input })
      .finish(() => ({}))
    // Completeness is the host's call: a coordinator never needs task handlers.
    expect(() =>
      verifyWorkflowsRegistry({ workflows: [implementation] }),
    ).toThrow(`Tasks [${task.name}]`)

    const runtime = createInMemoryWorkflowRuntime()
    const run = await runtime.store.createRun({
      workflowName: workflow.name,
      input: {},
    })
    await runtime.runCoordinationExecutor.enqueue({
      kind: 'continueRun',
      runId: run.id,
      workflowName: workflow.name,
    })

    const result = await runWorkflowWorker({
      ...runtime,
      workflows: [implementation],
      workerId: 'registry-partial',
    })

    expect(result.processed).toBe(1)
    expect(runtime.inspect().taskCommands).toHaveLength(1)
  })
})
