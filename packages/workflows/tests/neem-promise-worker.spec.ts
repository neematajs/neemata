import pino from 'pino'
import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'

import { defineTask, implementTask } from '../src/index.ts'
import { defineWorkflows, defineWorkflowsWorker } from '../src/neem/index.ts'
import {
  createInMemoryWorkflowRuntime,
  createWorkflowRuntimeClient,
  WorkflowCleanupTimeoutError,
} from '../src/runtime/index.ts'

const logger = pino({ enabled: false })

type Greeter = {
  readonly greeter: { readonly greet: (name: string) => string }
}

const greet = defineTask({
  name: 'neem.greet',
  input: z.string(),
  output: z.string(),
})
const greetImpl = implementTask(greet, {
  handler: (name, _lifecycle, env: Greeter) => env.greeter.greet(name),
})
const config = defineWorkflows({
  workflows: () => [],
  tasks: () => [greetImpl],
  workers: { execution: { pollIntervalMs: 1, cleanupTimeoutMs: 20 } },
})

function create(worker: ReturnType<typeof defineWorkflowsWorker>) {
  const channel = new MessageChannel()
  const runtime = worker.createRuntime({
    mode: 'development',
    name: 'workflows:execution:0',
    data: { role: 'execution' },
    logger,
    definition: worker.definition,
    port: channel.port1,
  })
  return {
    runtime,
    close: () => {
      channel.port1.close()
      channel.port2.close()
    },
  }
}

describe('Neem workflows worker without Effect', () => {
  it('checks the env that setup returns against the registered handlers', () => {
    const runtime = createInMemoryWorkflowRuntime()
    const greeter = { greet: (name: string) => `Hello, ${name}` }
    defineWorkflowsWorker(config, {
      setup: () => ({ runtime, env: { greeter } }),
    })
    // @ts-expect-error The task handler's greeter is missing.
    defineWorkflowsWorker(config, { setup: () => ({ runtime, env: {} }) })
    // @ts-expect-error Handlers that use an env need one.
    defineWorkflowsWorker(config, { setup: () => ({ runtime }) })
    defineWorkflowsWorker(defineWorkflows({ workflows: () => [] }), {
      setup: () => ({ runtime }),
    })
  })

  it('runs handlers with the env and disposes it after the adapter', async () => {
    const order: string[] = []
    const adapter = createInMemoryWorkflowRuntime()
    const worker = defineWorkflowsWorker(config, {
      setup: async () => ({
        runtime: { ...adapter, dispose: () => void order.push('adapter') },
        env: { greeter: { greet: (name: string) => `Hello, ${name}` } },
        dispose: () => void order.push('env'),
      }),
    })
    const { runtime, close } = create(worker)
    const instance = await runtime

    await instance.start()
    const client = createWorkflowRuntimeClient(adapter)
    const run = await client.start(greet, 'Ada')
    await vi.waitFor(async () =>
      expect((await client.get(run.id))?.run.output).toBe('Hello, Ada'),
    )
    await instance.stop()

    await expect(instance.finished).resolves.toBeUndefined()
    expect(order).toEqual(['adapter', 'env'])
    close()
  })

  it('disposes what setup acquired when a stop arrives during setup', async () => {
    const entered = Promise.withResolvers<void>()
    const setup = Promise.withResolvers<void>()
    const dispose = vi.fn()
    const worker = defineWorkflowsWorker(config, {
      setup: async () => {
        entered.resolve()
        await setup.promise
        return {
          runtime: createInMemoryWorkflowRuntime(),
          env: { greeter: { greet: (name: string) => name } },
          dispose,
        }
      },
    })
    const { runtime, close } = create(worker)
    const instance = await runtime

    const started = instance.start()
    const startup = expect(started).rejects.toThrow('stopped before readiness')
    await entered.promise
    const stopped = instance.stop()
    setup.resolve()

    await startup
    await stopped
    await expect(instance.finished).resolves.toBeUndefined()
    expect(dispose).toHaveBeenCalledOnce()
    close()
  })

  it('fails finished without disposing the env while a handler overruns cleanup', async () => {
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<string>()
    const dispose = vi.fn()
    const adapter = createInMemoryWorkflowRuntime()
    const worker = defineWorkflowsWorker(config, {
      setup: () => ({
        runtime: adapter,
        env: {
          greeter: {
            // Ignores its abort signal, like a Promise API without cancellation.
            greet: () => {
              entered.resolve()
              return release.promise as never
            },
          },
        },
        dispose,
      }),
    })
    const { runtime, close } = create(worker)
    const instance = await runtime

    await instance.start()
    await createWorkflowRuntimeClient(adapter).start(greet, 'Ada')
    await entered.promise
    const stopped = Promise.resolve(instance.stop()).catch(
      (error: unknown) => error,
    )

    await expect(instance.finished).rejects.toBeInstanceOf(
      WorkflowCleanupTimeoutError,
    )
    expect(dispose).not.toHaveBeenCalled()
    release.resolve('late')
    expect(await stopped).toBeInstanceOf(WorkflowCleanupTimeoutError)
    expect(dispose).toHaveBeenCalledOnce()
    close()
  })

  it('reports a setup failure through start and finished', async () => {
    const worker = defineWorkflowsWorker(config, {
      setup: () => {
        throw new Error('no database')
      },
    })
    const { runtime, close } = create(worker)
    const instance = await runtime

    await expect(instance.start()).rejects.toThrow('no database')
    await expect(instance.finished).rejects.toThrow('no database')
    close()
  })
})
