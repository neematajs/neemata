import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { describe, expect, expectTypeOf, it } from 'vitest'
import * as z from 'zod'

import type { Requirements } from '../src/effect/index.ts'
import type { Env } from '../src/index.ts'
import {
  defineTask as defineEffectTask,
  defineWorkflow as defineEffectWorkflow,
  implementWorkflow as implementEffectWorkflow,
} from '../src/effect/index.ts'
import { defineTask, defineWorkflow, implementWorkflow } from '../src/index.ts'

// A step bound without a mapper receives the workflow input as is. These
// workflows take a string while their steps take a number, so every binding
// below needs a mapper; the `same` ones take the workflow input itself.

type Clock = { readonly clock: { readonly now: () => number } }

describe('core chain: mapper required for incompatible step inputs', () => {
  const text = z.string()
  const count = z.number()
  const countTask = defineTask({
    name: 'r6.count',
    input: count,
    output: count,
  })
  const textTask = defineTask({ name: 'r6.text', input: text, output: text })
  const countChild = defineWorkflow({
    name: 'r6.count-child',
    input: count,
    output: count,
  }).build()
  const step = { input: count, output: count }
  const same = { input: text, output: text }

  it('rejects a task, activity or child workflow node without a mapper', () => {
    const taskNode = defineWorkflow({
      name: 'r6.task',
      input: text,
      output: count,
    })
      .task('step', countTask)
      .build()
    const activityNode = defineWorkflow({
      name: 'r6.activity',
      input: text,
      output: count,
    })
      .activity('step', step)
      .build()
    const childNode = defineWorkflow({
      name: 'r6.child',
      input: text,
      output: count,
    })
      .workflow('step', countChild)
      .build()

    // @ts-expect-error The task takes a number, the workflow a string.
    implementWorkflow(taskNode, { pool: 'test' }).step(countTask)
    implementWorkflow(taskNode, { pool: 'test' }).step(
      countTask,
      // @ts-expect-error Options without a mapper do not help.
      { idempotency: () => ['key'] },
    )
    // @ts-expect-error The activity takes a number, the workflow a string.
    implementWorkflow(activityNode, { pool: 'test' }).step((input) => input + 1)
    // @ts-expect-error The child takes a number, the workflow a string.
    implementWorkflow(childNode, { pool: 'test' }).step(countChild)

    implementWorkflow(taskNode, { pool: 'test' })
      .step(countTask, { input: (_outputs, input) => Number(input) })
      .finish(({ step }) => step)
    implementWorkflow(childNode, { pool: 'test' })
      .step(countChild, { input: (_outputs, input) => Number(input) })
      .finish(({ step }) => step)
    const mapped = implementWorkflow(activityNode, { pool: 'test' })
      .step((input, _lifecycle, env: Clock) => input + env.clock.now(), {
        input: (_outputs, input) => Number(input),
      })
      .finish(({ step }) => step)
    expectTypeOf<Env<typeof mapped>>().toEqualTypeOf<Clock>()
  })

  it('keeps the mapper optional when the step takes the workflow input', () => {
    const compatible = defineWorkflow({
      name: 'r6.compatible',
      input: text,
      output: text,
    })
      .task('task', textTask)
      .activity('activity', same)
      .parallel('pair', (h) => ({
        task: h.task(textTask),
        bare: h.activity(same),
      }))
      .build()

    const implementation = implementWorkflow(compatible, { pool: 'test' })
      .task(textTask)
      .activity((input, _lifecycle, env: Clock) => `${input}${env.clock.now()}`)
      .pair({ task: textTask, bare: (input) => input })
      .finish(({ pair }) => pair.bare)
    expectTypeOf<Env<typeof implementation>>().toEqualTypeOf<Clock>()
    expect(implementation.nodes).toHaveLength(3)
  })

  it('rejects parallel members and branch cases without a mapper', () => {
    const cases = defineWorkflow({
      name: 'r6.cases',
      input: text,
      output: count,
    })
      .parallel('pair', (h) => ({
        task: h.task(countTask),
        activity: h.activity(step),
      }))
      .branch('pick', {
        cases: (h) => ({ task: h.task(countTask), activity: h.activity(step) }),
        output: count,
      })
      .build()
    const chain = implementWorkflow(cases, { pool: 'test' })

    chain.pair(({ task, activity }) => ({
      // @ts-expect-error The task member takes a number.
      task: task(countTask),
      // @ts-expect-error The activity member takes a number.
      activity: activity((input) => input + 1),
    }))
    chain.pair({
      // @ts-expect-error A bare task has no mapper.
      task: countTask,
      // @ts-expect-error Nor has a bare handler.
      activity: (input: number) => input + 1,
    })

    const mapped = chain
      .pair(({ task, activity }) => ({
        task: task(countTask, { input: (_outputs, input) => Number(input) }),
        activity: activity(
          (input, _lifecycle, env: Clock) => input + env.clock.now(),
          { input: (_outputs, input) => Number(input) },
        ),
      }))
      .pick({
        select: () => 'task',
        cases: ({ task, activity }) => ({
          task: task(countTask, { input: ({ pair }) => pair.task }),
          activity: activity((input) => input + 1, {
            input: ({ pair }) => pair.activity,
          }),
        }),
      })
      .finish(({ pick }) => pick)
    expectTypeOf<Env<typeof mapped>>().toEqualTypeOf<Clock>()

    chain
      .pair(({ task, activity }) => ({
        task: task(countTask, { input: (_outputs, input) => Number(input) }),
        activity: activity((input) => input + 1, {
          input: (_outputs, input) => Number(input),
        }),
      }))
      .pick({
        select: () => 'task',
        cases: ({ task, activity }) => ({
          // @ts-expect-error The task case takes a number.
          task: task(countTask),
          // @ts-expect-error The activity case takes a number.
          activity: activity((input) => input + 1),
        }),
      })
  })

  it('stays permissive for untyped inputs', () => {
    const anyTask = defineTask({
      name: 'r6.any',
      input: z.any(),
      output: z.any(),
    })
    const untyped = defineWorkflow({
      name: 'r6.untyped',
      input: text,
      output: count,
    })
      .task('loose', anyTask)
      .build()
    const erased = defineWorkflow({
      name: 'r6.erased',
      input: z.any(),
      output: count,
    })
      .task('step', countTask)
      .build()

    implementWorkflow(untyped, { pool: 'test' })
      .loose(anyTask)
      .finish(() => 1)
    implementWorkflow(erased, { pool: 'test' })
      .step(countTask)
      .finish(({ step }) => step)
  })
})

describe('Effect chain: mapper required for incompatible step inputs', () => {
  class Service extends Context.Service<Service, { value: number }>()(
    'r6/Service',
  ) {}
  const text = Schema.String
  const count = Schema.Number
  const countTask = defineEffectTask({
    name: 'r6.effect.count',
    input: count,
    output: count,
  })
  const textTask = defineEffectTask({
    name: 'r6.effect.text',
    input: text,
    output: text,
  })
  const step = { input: count, output: count }
  const same = { input: text, output: text }
  const add = (input: number) =>
    Service.pipe(Effect.map(({ value }) => input + value))

  it('rejects a task or activity node without a mapper', () => {
    const taskNode = defineEffectWorkflow({
      name: 'r6.effect.task',
      input: text,
      output: count,
    })
      .task('step', countTask)
      .build()
    const activityNode = defineEffectWorkflow({
      name: 'r6.effect.activity',
      input: text,
      output: count,
    })
      .activity('step', step)
      .build()

    // @ts-expect-error The task takes a number, the workflow a string.
    implementEffectWorkflow(taskNode, { pool: 'test' }).step(countTask)
    implementEffectWorkflow(activityNode, { pool: 'test' })
      // @ts-expect-error The activity takes a number, the workflow a string.
      .step((input) => Effect.succeed(input + 1))

    implementEffectWorkflow(taskNode, { pool: 'test' })
      .step(countTask, { input: (_outputs, input) => Number(input) })
      .finish(({ step }) => Effect.succeed(step))
    const mapped = implementEffectWorkflow(activityNode, { pool: 'test' })
      .step((input) => add(input), {
        input: (_outputs, input) => Number(input),
      })
      .finish(({ step }) => Effect.succeed(step))
    expectTypeOf<Requirements<typeof mapped>>().toEqualTypeOf<Service>()
  })

  it('keeps the mapper optional when the step takes the workflow input', () => {
    const compatible = defineEffectWorkflow({
      name: 'r6.effect.compatible',
      input: text,
      output: text,
    })
      .task('task', textTask)
      .activity('activity', same)
      .parallel('pair', (h) => ({
        task: h.task(textTask),
        bare: h.activity(same),
      }))
      .build()

    const implementation = implementEffectWorkflow(compatible, { pool: 'test' })
      .task(textTask)
      .activity((input) =>
        Service.pipe(Effect.map(({ value }) => `${input}${value}`)),
      )
      .pair({ task: textTask, bare: (input) => Effect.succeed(input) })
      .finish(({ pair }) => Effect.succeed(pair.bare))
    expectTypeOf<Requirements<typeof implementation>>().toEqualTypeOf<Service>()
    expect(implementation.nodes).toHaveLength(3)
  })

  it('rejects parallel members and branch cases without a mapper', () => {
    const cases = defineEffectWorkflow({
      name: 'r6.effect.cases',
      input: text,
      output: count,
    })
      .parallel('pair', (h) => ({
        task: h.task(countTask),
        activity: h.activity(step),
      }))
      .branch('pick', {
        cases: (h) => ({ task: h.task(countTask), activity: h.activity(step) }),
        output: count,
      })
      .build()
    const chain = implementEffectWorkflow(cases, { pool: 'test' })

    chain.pair(({ task, activity }) => ({
      // @ts-expect-error The task member takes a number.
      task: task(countTask),
      // @ts-expect-error The activity member takes a number.
      activity: activity((input) => Effect.succeed(input + 1)),
    }))
    chain.pair({
      // @ts-expect-error A bare task has no mapper.
      task: countTask,
      // @ts-expect-error Nor has a bare handler.
      activity: (input: number) => Effect.succeed(input + 1),
    })

    const mapped = chain
      .pair(({ task, activity }) => ({
        task: task(countTask, { input: (_outputs, input) => Number(input) }),
        activity: activity((input) => add(input), {
          input: (_outputs, input) => Number(input),
        }),
      }))
      .pick({
        select: () => 'task',
        cases: ({ task, activity }) => ({
          task: task(countTask, { input: ({ pair }) => pair.task }),
          activity: activity((input) => Effect.succeed(input + 1), {
            input: ({ pair }) => pair.activity,
          }),
        }),
      })
      .finish(({ pick }) => Effect.succeed(pick))
    expectTypeOf<Requirements<typeof mapped>>().toEqualTypeOf<Service>()

    chain
      .pair(({ task, activity }) => ({
        task: task(countTask, { input: (_outputs, input) => Number(input) }),
        activity: activity((input) => Effect.succeed(input + 1), {
          input: (_outputs, input) => Number(input),
        }),
      }))
      .pick({
        select: () => 'task',
        cases: ({ task, activity }) => ({
          // @ts-expect-error The task case takes a number.
          task: task(countTask),
          // @ts-expect-error The activity case takes a number.
          activity: activity((input) => Effect.succeed(input + 1)),
        }),
      })
  })
})
