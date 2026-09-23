import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import {
  defineSchedule,
  defineTask,
  defineWorkflow,
  implementTask,
  implementWorkflow,
} from '../src/index.ts'
import { resolveWorkflowsRegistry } from '../src/neem/runtime.ts'

describe('schedule targets in registry validation', () => {
  const io = { input: z.object({}), output: z.object({}) }
  const data = { role: 'coordinator' } as const
  const target = defineWorkflow({ name: 'registry.target', ...io }).build()
  const targetImpl = implementWorkflow(target, { pool: 'test' }).finish(
    () => ({}),
  )
  const task = defineTask({ name: 'registry.target-task', ...io })
  const taskImpl = implementTask(task, { pool: 'test', handler: () => ({}) })
  const every = { input: {}, every: '1h' } as const

  it('accepts schedules whose targets are registered', async () => {
    const schedules = [
      defineSchedule({ name: 'workflow', runnable: target, ...every }),
      defineSchedule({ name: 'task', runnable: task, ...every }),
    ]
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [targetImpl],
          tasks: () => [taskImpl],
          schedules: () => schedules,
        },
        data,
      ),
    ).resolves.toMatchObject({ schedules })
  })

  it('rejects a schedule whose task or workflow has no implementation', async () => {
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [targetImpl],
          schedules: () => [
            defineSchedule({ name: 'task', runnable: task, ...every }),
          ],
        },
        data,
      ),
    ).rejects.toThrow(
      `[${task.name}] targeted by schedules have no registered implementation`,
    )
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [],
          tasks: () => [taskImpl],
          schedules: () => [
            defineSchedule({ name: 'workflow', runnable: target, ...every }),
          ],
        },
        data,
      ),
    ).rejects.toThrow(
      `[${target.name}] targeted by schedules have no registered implementation`,
    )
  })

  it('rejects a schedule targeting a same-named copy of a registered definition', async () => {
    const taskCopy = defineTask({ name: task.name, ...io })
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [targetImpl],
          tasks: () => [taskImpl],
          schedules: () => [
            defineSchedule({ name: 'task', runnable: taskCopy, ...every }),
          ],
        },
        data,
      ),
    ).rejects.toThrow(`Definitions [${task.name}] exist as more than one`)
    const targetCopy = defineWorkflow({ name: target.name, ...io }).build()
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [targetImpl],
          schedules: () => [
            defineSchedule({ name: 'copy', runnable: targetCopy, ...every }),
          ],
        },
        data,
      ),
    ).rejects.toThrow(`Definitions [${target.name}] exist as more than one`)
  })
})

describe('duplicate implementations in registry validation', () => {
  const io = { input: z.object({}), output: z.object({}) }
  const data = { role: 'execution' } as const
  const workflow = defineWorkflow({
    name: 'registry.duplicate-workflow',
    ...io,
  }).build()
  const implement = () =>
    implementWorkflow(workflow, { pool: 'test' }).finish(() => ({}))
  const task = defineTask({ name: 'registry.duplicate-task', ...io })
  const implementDuplicateTask = () =>
    implementTask(task, { pool: 'test', handler: () => ({}) })

  it('rejects two implementations of one workflow', async () => {
    await expect(
      resolveWorkflowsRegistry(
        { workflows: () => [implement(), implement()] },
        data,
      ),
    ).rejects.toThrow(
      `Implementations [workflow:${workflow.name}] are registered more than once`,
    )
  })

  it('rejects two implementations of one task', async () => {
    await expect(
      resolveWorkflowsRegistry(
        {
          workflows: () => [implement()],
          tasks: () => [implementDuplicateTask(), implementDuplicateTask()],
        },
        data,
      ),
    ).rejects.toThrow(
      `Implementations [task:${task.name}] are registered more than once`,
    )
  })

  it('still accepts one implementation listed more than once', async () => {
    const workflowImplementation = implement()
    const taskImplementation = implementDuplicateTask()
    const resolved = await resolveWorkflowsRegistry(
      {
        workflows: () => [workflowImplementation, workflowImplementation],
        tasks: () => [taskImplementation, taskImplementation],
      },
      data,
    )
    expect(resolved.workflows).toStrictEqual([workflowImplementation])
    expect(resolved.tasks).toStrictEqual([taskImplementation])
  })
})
