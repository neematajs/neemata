import { MessageChannel } from 'node:worker_threads'

import type { NeemRuntime, NeemRuntimeWorker } from '@nmtjs/neem'
import { defineRuntimeWorker } from '@nmtjs/neem'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkflowsWorkerData } from '../src/neem/runtime.ts'
import { hmrAdapter as adapter } from '../src/neem/hmr.ts'

type Worker = NeemRuntimeWorker<WorkflowsWorkerData, unknown>
const channels: MessageChannel[] = []

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close()
    channel.port2.close()
  }
})

describe('workflow HMR lifecycle', () => {
  it('joins the old generation before starting the next and keeps finished pending', async () => {
    const events: string[] = []
    const first = createWorker('first')
    const second = createWorker('second')
    const runtime = await createRuntime(first)
    const finished = vi.fn()
    void runtime.finished?.then(finished)
    await runtime.start()
    await expect(adapter.apply(runtime, first, second)).resolves.toEqual({
      accepted: true,
    })
    expect(events).toEqual(['start:first', 'stop:first', 'start:second'])
    expect(finished).not.toHaveBeenCalled()
    await runtime.stop()
    await expect(runtime.finished).resolves.toBeUndefined()
    expect(events).toEqual([
      'start:first',
      'stop:first',
      'start:second',
      'stop:second',
    ])

    function createWorker(name: string) {
      return defineRuntimeWorker<WorkflowsWorkerData>({
        definition: name,
        createRuntime() {
          const finished = Promise.withResolvers<void>()
          return {
            finished: finished.promise,
            start() {
              events.push(`start:${name}`)
            },
            stop() {
              events.push(`stop:${name}`)
              finished.resolve()
            },
          }
        },
      })
    }
  })

  it('disposes a replacement that fails to start', async () => {
    const first = worker({ start() {}, stop() {} })
    const stop = vi.fn()
    const next = worker({
      start() {
        throw new Error('setup failed')
      },
      stop,
    })
    const runtime = await createRuntime(first)
    await runtime.start()
    await expect(adapter.apply(runtime, first, next)).rejects.toThrow(
      'setup failed',
    )
    expect(stop).toHaveBeenCalledOnce()
    await runtime.stop()
  })

  it('delivers stop while the replacement is awaiting readiness', async () => {
    const first = worker({ start() {}, stop() {} })
    const started = Promise.withResolvers<void>()
    const ready = Promise.withResolvers<undefined>()
    const next = worker({
      start() {
        started.resolve()
        return ready.promise
      },
      stop() {
        ready.reject(new Error('startup interrupted'))
      },
    })
    const runtime = await createRuntime(first)
    await runtime.start()
    const applying = expect(
      adapter.apply(runtime, first, next),
    ).rejects.toThrow('startup interrupted')
    await started.promise
    await runtime.stop()
    await applying
    await expect(runtime.finished).resolves.toBeUndefined()
  })

  it('disposes a replacement acquired after stop without starting it', async () => {
    const first = worker({ start() {}, stop() {} })
    const creating = Promise.withResolvers<void>()
    const acquired = Promise.withResolvers<NeemRuntime>()
    const start = vi.fn()
    const stop = vi.fn()
    const next = defineRuntimeWorker<WorkflowsWorkerData>({
      definition: undefined,
      createRuntime() {
        creating.resolve()
        return acquired.promise
      },
    })
    const runtime = await createRuntime(first)
    await runtime.start()
    const applying = expect(
      adapter.apply(runtime, first, next),
    ).rejects.toThrow('Workflows runtime stopped')
    await creating.promise
    const stopping = runtime.stop()
    acquired.resolve({ start, stop })
    await stopping
    await applying
    expect(start).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reports an active replacement failure through finished', async () => {
    const first = worker({ start() {}, stop() {} })
    const finished = Promise.withResolvers<void>()
    const next = worker({ start() {}, stop() {}, finished: finished.promise })
    const runtime = await createRuntime(first)
    await runtime.start()
    await adapter.apply(runtime, first, next)
    finished.reject(new Error('loop failed'))
    await expect(runtime.finished).rejects.toThrow('loop failed')
    await runtime.stop()
  })
})

function worker(runtime: NeemRuntime): Worker {
  return defineRuntimeWorker<WorkflowsWorkerData>({
    definition: undefined,
    createRuntime() {
      return runtime
    },
  })
}

function createRuntime(worker: Worker) {
  const channel = new MessageChannel()
  channels.push(channel)
  return adapter.createRuntime(worker, {
    mode: 'development',
    name: 'workflows:execution:0',
    data: { role: 'execution', pool: 'io' },
    logger: pino({ level: 'silent' }),
    definition: worker.definition,
    port: channel.port1,
  })
}
