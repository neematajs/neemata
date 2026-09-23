import { MessageChannel } from 'node:worker_threads'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { pino } from 'pino'
import { describe, expect, it } from 'vitest'
import * as z from 'zod'

import type { WorkflowsWorkerData } from '../src/neem/runtime.ts'
import {
  defineWorkflow as defineEffectWorkflow,
  implementWorkflow as implementEffectWorkflow,
} from '../src/effect/index.ts'
import { defineWorkflowsWorker as defineEffectWorkflowsWorker } from '../src/effect/neem.ts'
import {
  defineSchedule,
  defineWorkflow,
  implementWorkflow,
} from '../src/index.ts'
import { defineWorkflowsWorker } from '../src/neem/index.ts'
import {
  createInMemoryWorkflowRuntime,
  WorkflowCleanupTimeoutError,
  type WorkflowRuntimeAdapter,
} from '../src/runtime/index.ts'

const logger = pino({ enabled: false })

const workflow = defineEffectWorkflow({
  name: 'startup.empty',
  input: Schema.Struct({ id: Schema.String }),
  output: Schema.Struct({ id: Schema.String }),
}).build()
const workflowImpl = implementEffectWorkflow(workflow, { pool: 'test' }).finish(
  (_outputs, input) => Effect.succeed({ id: input.id }),
)
const schedule = defineSchedule({
  name: 'startup.schedule',
  runnable: workflow,
  input: { id: 'scheduled' },
  every: '1h',
})

type Worker = {
  readonly definition: unknown
  readonly createRuntime: (ctx: any) => any
}

async function createCoordinator(worker: Worker) {
  const channel = new MessageChannel()
  const data: WorkflowsWorkerData = {
    role: 'coordinator',
    settings: { pollIntervalMs: 1, cleanupTimeoutMs: 5 },
  }
  const runtime = await worker.createRuntime({
    mode: 'development',
    name: 'workflows:coordinator:0',
    data,
    logger,
    definition: worker.definition,
    port: channel.port1,
  })
  return {
    runtime: runtime as {
      readonly finished: Promise<void>
      start(): Promise<unknown>
      stop(): Promise<void>
    },
    close: () => {
      channel.port1.close()
      channel.port2.close()
    },
  }
}

/** An adapter whose reconciliation fails and whose disposal hangs until released. */
function createHangingAdapter() {
  const released = Promise.withResolvers<void>()
  const adapter = createInMemoryWorkflowRuntime()
  const runtime: WorkflowRuntimeAdapter = {
    ...adapter,
    scheduler: {
      ...adapter.scheduler!,
      reconcile: () => Promise.reject(new Error('reconcile failed')),
    },
    dispose: () => released.promise,
  }
  return { runtime, release: () => released.resolve() }
}

const settled = (promise: Promise<unknown>) =>
  Promise.race([
    promise.then(
      () => 'resolved',
      (error: unknown) => error,
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
  ])

describe('worker startup cleanup deadline', () => {
  it('bounds a hanging adapter disposal after an Effect worker fails to start', async () => {
    const adapter = createHangingAdapter()
    const worker = defineEffectWorkflowsWorker({
      workflows: () => [workflowImpl],
      schedules: () => [schedule],
      runtime: Effect.sync(() => adapter.runtime),
    })
    const { runtime, close } = await createCoordinator(worker)

    try {
      const start = runtime.start()
      expect(await settled(start)).toBeInstanceOf(WorkflowCleanupTimeoutError)
      expect(await settled(runtime.finished)).toBeInstanceOf(
        WorkflowCleanupTimeoutError,
      )
    } finally {
      adapter.release()
      await runtime.stop().catch(() => {})
      close()
    }
  })

  it('bounds a hanging Layer finalizer after an Effect worker fails to start', async () => {
    const released = Promise.withResolvers<void>()
    const adapter = createHangingAdapter()
    const worker = defineEffectWorkflowsWorker({
      workflows: () => [workflowImpl],
      schedules: () => [schedule],
      runtime: Effect.sync(() => ({ ...adapter.runtime, dispose: () => {} })),
      layer: Layer.effectDiscard(
        Effect.addFinalizer(() => Effect.promise(() => released.promise)),
      ),
    })
    const { runtime, close } = await createCoordinator(worker)

    try {
      const start = runtime.start()
      expect(await settled(start)).toBeInstanceOf(WorkflowCleanupTimeoutError)
      expect(await settled(runtime.finished)).toBeInstanceOf(
        WorkflowCleanupTimeoutError,
      )
    } finally {
      released.resolve()
      await runtime.stop().catch(() => {})
      close()
    }
  })

  it('bounds a hanging adapter disposal after a Promise worker fails to start', async () => {
    const adapter = createHangingAdapter()
    const core = defineWorkflow({
      name: 'startup.core-empty',
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string() }),
    }).build()
    const coreImpl = implementWorkflow(core, { pool: 'test' }).finish(
      (_outputs, input) => input,
    )
    const worker = defineWorkflowsWorker({
      workflows: () => [coreImpl],
      schedules: () => [
        defineSchedule({
          name: 'startup.core-schedule',
          runnable: core,
          input: { id: 'scheduled' },
          every: '1h',
        }),
      ],
      setup: () => ({ runtime: adapter.runtime }),
    })
    const { runtime, close } = await createCoordinator(worker)

    try {
      const start = runtime.start()
      expect(await settled(start)).toBeInstanceOf(WorkflowCleanupTimeoutError)
      expect(await settled(runtime.finished)).toBeInstanceOf(
        WorkflowCleanupTimeoutError,
      )
    } finally {
      adapter.release()
      await runtime.stop().catch(() => {})
      close()
    }
  })
})
