import { MessageChannel } from 'node:worker_threads'

import type { NeemRuntime, NeemRuntimeWorker } from '@nmtjs/neem'
import { defineRuntimeWorker } from '@nmtjs/neem'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReloadableRuntime } from '../../src/internal/worker/reloadable-runtime.ts'

type Worker = NeemRuntimeWorker
const channels: MessageChannel[] = []

afterEach(() => {
  for (const channel of channels.splice(0)) {
    channel.port1.close()
    channel.port2.close()
  }
})

describe('worker generation lifecycle', () => {
  it('joins the old generation before starting the next and keeps finished pending', async () => {
    const events: string[] = []
    const first = createWorker('first')
    const second = createWorker('second')
    const runtime = await createRuntime(first)
    const finished = vi.fn()
    void runtime.finished?.then(finished)
    await runtime.start()
    await expect(runtime.apply(second)).resolves.toEqual({ outcome: 'applied' })
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
      return defineRuntimeWorker<unknown>({
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
    await expect(runtime.apply(next)).resolves.toMatchObject({
      error: { message: 'setup failed' },
    })
    expect(stop).toHaveBeenCalledOnce()
    await runtime.stop()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('replacement start failure is reported as unavailable, not as a rejection', async () => {
    const firstStop = vi.fn()
    const first = worker({ start() {}, stop: firstStop })
    const next = worker({
      start() {
        throw new Error('setup failed')
      },
      stop() {},
    })
    const runtime = await createRuntime(first)
    await runtime.start()

    // The old generation was retired before the replacement failed.
    await expect(runtime.apply(next)).resolves.toMatchObject({
      outcome: 'unavailable',
      error: { message: 'setup failed' },
    })
    expect(firstStop).toHaveBeenCalledOnce()
    await runtime.stop()
  })

  it('rejects an update without touching the generation while one is replacing', async () => {
    const firstStop = vi.fn()
    const first = worker({ start() {}, stop: firstStop })
    const ready = Promise.withResolvers<undefined>()
    const slow = worker({ start: () => ready.promise, stop() {} })
    const runtime = await createRuntime(first)
    await runtime.start()
    const applying = runtime.apply(slow)

    await expect(
      runtime.apply(worker({ start() {}, stop() {} })),
    ).resolves.toMatchObject({
      outcome: 'rejected',
      error: { message: 'Neem runtime is already reloading' },
    })
    ready.resolve(undefined)
    await expect(applying).resolves.toEqual({ outcome: 'applied' })
    await runtime.stop()
    await expect(runtime.apply(first)).resolves.toMatchObject({
      outcome: 'rejected',
    })
  })

  it('allows unchanged upstreams and disposes a generation that changes them', async () => {
    const upstreams = [{ type: 'http' as const, url: 'http://127.0.0.1:12345' }]
    const first = worker({ start: () => upstreams, stop() {} })
    const same = worker({ start: () => [...upstreams], stop() {} })
    const stop = vi.fn()
    const changed = worker({ start: () => [], stop })
    const runtime = await createRuntime(first)
    await runtime.start()
    await runtime.apply(same)

    await expect(runtime.apply(changed)).resolves.toMatchObject({
      outcome: 'unavailable',
      error: { message: expect.stringContaining('changed runtime upstreams') },
    })
    expect(stop).toHaveBeenCalledOnce()
    await runtime.stop()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('reports an active generation ending without a stop', async () => {
    const finished = Promise.withResolvers<void>()
    const runtime = await createRuntime(
      worker({ start() {}, stop() {}, finished: finished.promise }),
    )
    await runtime.start()
    finished.resolve()
    await expect(runtime.finished).rejects.toThrow(
      'finished before stop was requested',
    )
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
    const applying = expect(runtime.apply(next)).resolves.toMatchObject({
      outcome: 'unavailable',
      error: { message: 'startup interrupted' },
    })
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
    const next = defineRuntimeWorker<unknown>({
      definition: undefined,
      createRuntime() {
        creating.resolve()
        return acquired.promise
      },
    })
    const runtime = await createRuntime(first)
    await runtime.start()
    const applying = expect(runtime.apply(next)).resolves.toMatchObject({
      outcome: 'unavailable',
      error: { message: 'Neem runtime stopped' },
    })
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
    await expect(runtime.apply(next)).resolves.toEqual({ outcome: 'applied' })
    finished.reject(new Error('loop failed'))
    await expect(runtime.finished).rejects.toThrow('loop failed')
    await runtime.stop()
  })
})

function worker(runtime: NeemRuntime): Worker {
  return defineRuntimeWorker<unknown>({
    definition: undefined,
    createRuntime() {
      return runtime
    },
  })
}

function createRuntime(worker: Worker) {
  const channel = new MessageChannel()
  channels.push(channel)
  return ReloadableRuntime.create(worker, {
    mode: 'development',
    name: 'workflows:execution:0',
    data: { role: 'execution', pool: 'io' },
    logger: pino({ level: 'silent' }),
    definition: worker.definition,
    port: channel.port1,
  })
}
