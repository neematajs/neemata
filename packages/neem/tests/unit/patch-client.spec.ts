import { runInThisContext } from 'node:vm'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WorkerUpdate } from '../../src/internal/build/updates.ts'
import type {
  PatchClient,
  PatchGlobal,
} from '../../src/internal/worker/patch-globals.ts'
import { NEEM_DEV_RUNTIME } from '../../src/internal/build/dev-runtime.ts'

type HotContext = {
  data: Record<string, unknown>
  accept: (callback?: (module: unknown) => unknown) => void
  dispose: (callback: (data: Record<string, unknown>) => unknown) => void
}

type ModuleBody = (hot: HotContext) => unknown

type TestGlobal = PatchGlobal & { __rolldown_runtime__?: StubDevRuntime }

const testGlobal = globalThis as TestGlobal

afterEach(() => {
  delete testGlobal.__rolldown_runtime__
  delete testGlobal.__neem_patches__
  delete testGlobal.__neem_patch_client_id__
  delete testGlobal.__neem_patch_guard__
})

// Models what the client needs from Rolldown's DevRuntime: the initial bundle
// runs modules without factories; a patch registers factories that
// initModule runs once the module cache no longer holds the module.
class StubDevRuntime {
  importers = new Map<string, Set<string>>()
  hooks: {
    createModuleHotContext: (id: string) => unknown
    onModuleCacheRemoval: (id: string) => void
  } | null = null
  readonly executed = new Set<string>()
  readonly factories = new Map<string, ModuleBody>()
  readonly exports = new Map<string, unknown>()

  constructor(readonly clientId: string) {}

  isExecuted(id: string): boolean {
    return this.executed.has(id)
  }

  getImporters(id: string): string[] {
    return [...(this.importers.get(id) ?? [])]
  }

  hasFactory(id: string): boolean {
    return this.factories.has(id)
  }

  removeModuleCache(id: string): void {
    this.executed.delete(id)
    this.exports.delete(id)
    this.hooks?.onModuleCacheRemoval(id)
  }

  initModule(id: string): unknown {
    if (this.executed.has(id)) return this.exports.get(id)
    const factory = this.factories.get(id)
    if (!factory) throw new Error(`no factory for ${id}`)
    return this.run(id, factory)
  }

  loadExports(id: string): unknown {
    return this.exports.get(id)
  }

  run(id: string, body: ModuleBody): unknown {
    this.executed.add(id)
    const hot = this.hooks!.createModuleHotContext(id) as HotContext
    const exports = body(hot)
    this.exports.set(id, exports)
    return exports
  }
}

describe('patch client', () => {
  it('applies a no-op update without loading anything', async () => {
    const { client, load } = install()

    await expect(client.apply({ type: 'Noop' }, load)).resolves.toEqual({
      outcome: 'applied',
      delivered: false,
    })
    expect(load).not.toHaveBeenCalled()
  })

  it('rejects a full reload with its reason', async () => {
    const { client, load } = install()

    await expect(
      client.apply({ type: 'FullReload', reason: 'entry changed' }, load),
    ).resolves.toEqual({
      outcome: 'rejected',
      delivered: false,
      reason: 'entry changed',
    })
    await expect(client.apply({ type: 'FullReload' }, load)).resolves.toEqual({
      outcome: 'rejected',
      delivered: false,
      reason: 'Rolldown requested a full reload',
    })
  })

  it('rejects a patch that skips a sequence number', async () => {
    const { client, load } = install()

    await expect(client.apply(patch(2, ['dep']), load)).resolves.toEqual({
      outcome: 'rejected',
      delivered: false,
      reason: 'Patch sequence gap: expected 1, received 2',
    })
    expect(load).not.toHaveBeenCalled()
  })

  it('rejects a change that reaches no accepting module', async () => {
    const { client, runtime, load } = install()
    runtime.importers.set('dep', new Set(['entry']))
    runtime.run('entry', () => ({}))
    runtime.run('dep', () => ({}))

    await expect(client.apply(patch(1, ['dep']), load)).resolves.toEqual({
      outcome: 'rejected',
      delivered: false,
      reason: 'no patch boundary for entry',
    })
  })

  it('rejects a change to modules that have not run before loading it', async () => {
    const { client, load } = install()

    await expect(client.apply(patch(1, ['lazy']), load)).resolves.toEqual({
      outcome: 'rejected',
      delivered: false,
      reason: 'update changes modules that have not run yet: lazy',
    })
    expect(load).not.toHaveBeenCalled()
  })

  it('rejects a loaded patch whose other changes no update reaches', async () => {
    const { client, runtime } = install()
    const app = acceptingApp(runtime)
    const load = vi.fn(async () => app.registerFactories())

    await expect(
      client.apply(patch(1, ['dep', 'lazy']), load),
    ).resolves.toEqual({
      outcome: 'rejected',
      delivered: true,
      reason: 'update changes modules that have not run yet: lazy',
    })
    expect(app.events).toEqual([])
  })

  it('rejects a patch whose file fails to import', async () => {
    const { client, runtime } = install()
    acceptingApp(runtime)
    const load = vi.fn(async () => {
      throw new Error('boom')
    })

    await expect(client.apply(patch(1, ['dep']), load)).resolves.toEqual({
      outcome: 'rejected',
      delivered: false,
      reason: 'failed to import patch: Error: boom',
    })
  })

  it('rejects a delivered patch that registers no factory for a module it replaces', async () => {
    const { client, runtime, load } = install()
    const app = acceptingApp(runtime)

    await expect(client.apply(patch(1, ['dep']), load)).resolves.toEqual({
      outcome: 'rejected',
      delivered: true,
      reason: 'patch has no factory for dep',
    })
    expect(app.events).toEqual([])
  })

  it('reports the generation unavailable when a disposer throws', async () => {
    const { client, runtime } = install()
    const app = acceptingApp(runtime, {
      dispose: () => {
        throw new Error('dispose failed')
      },
    })
    const load = vi.fn(async () => app.registerFactories())

    await expect(client.apply(patch(1, ['dep']), load)).resolves.toEqual({
      outcome: 'unavailable',
      delivered: true,
      reason: 'failed to apply patch: Error: dispose failed',
    })
  })

  it('rejects a patch the worker guard refuses before disposing anything', async () => {
    const { client, runtime } = install()
    const app = acceptingApp(runtime)
    const load = vi.fn(async () => app.registerFactories())
    const guard = vi.fn(() => "Worker requires reload: 'thread'")
    testGlobal.__neem_patch_guard__ = guard

    await expect(client.apply(patch(1, ['dep']), load)).resolves.toEqual({
      outcome: 'rejected',
      delivered: true,
      reason: "Worker requires reload: 'thread'",
    })
    expect(load).toHaveBeenCalledOnce()
    expect(guard).toHaveBeenCalledOnce()
    expect(app.events).toEqual([])
  })

  it('does not consult the guard for a patch its own checks reject', async () => {
    const { client, runtime, load } = install()
    acceptingApp(runtime)
    const guard = vi.fn(() => undefined)
    testGlobal.__neem_patch_guard__ = guard

    await expect(client.apply(patch(1, ['dep']), load)).resolves.toMatchObject({
      outcome: 'rejected',
      reason: 'patch has no factory for dep',
    })
    expect(guard).not.toHaveBeenCalled()
  })

  it('reports the generation unavailable when the accept callback fails', async () => {
    const { client, runtime } = install()
    const app = acceptingApp(runtime, {
      accept: () => {
        throw new Error("Updated worker requires reload: 'thread'")
      },
    })
    const load = vi.fn(async () => app.registerFactories())
    testGlobal.__neem_patch_guard__ = () => undefined

    await expect(client.apply(patch(1, ['dep']), load)).resolves.toEqual({
      outcome: 'unavailable',
      delivered: true,
      reason:
        "failed to apply patch: Error: Updated worker requires reload: 'thread'",
    })
    expect(app.events).toEqual([
      'dispose:entry',
      'run:entry:undefined',
      'run:dep',
      'accept:v2',
    ])
  })

  it('re-executes up to the accepting module and hands dispose data over', async () => {
    const { client, runtime } = install()
    const app = acceptingApp(runtime, {
      dispose: (data) => {
        data.generation = 1
      },
    })
    const load = vi.fn(async () => app.registerFactories())

    await expect(client.apply(patch(1, ['dep']), load)).resolves.toEqual({
      outcome: 'applied',
      delivered: true,
    })
    expect(app.events).toEqual([
      'dispose:entry',
      'run:entry:1',
      'run:dep',
      'accept:v2',
    ])
    // The next patch continues the sequence.
    await expect(client.apply(patch(2, []), load)).resolves.toMatchObject({
      outcome: 'applied',
    })
  })
})

function install() {
  testGlobal.__neem_patch_client_id__ = 'api:0'
  // The prelude declares DevRuntime in the scope the client source runs in.
  const evaluate = runInThisContext(
    `(DevRuntime) => {\n${NEEM_DEV_RUNTIME}\n}`,
  ) as (runtime: typeof StubDevRuntime) => void
  evaluate(StubDevRuntime)
  const client = testGlobal.__neem_patches__ as PatchClient
  const runtime = testGlobal.__rolldown_runtime__!
  expect(client.clientId).toBe('api:0')
  return { client, runtime, load: vi.fn(async () => {}) }
}

function patch(seq: number, changedIds: string[]): WorkerUpdate {
  return { type: 'Patch', filename: `patch-${seq}.js`, seq, changedIds }
}

// `entry` imports `dep` and accepts itself, as a worker definition does.
function acceptingApp(
  runtime: StubDevRuntime,
  hooks: {
    dispose?: (data: Record<string, unknown>) => void
    accept?: (module: unknown) => void
  } = {},
) {
  const events: string[] = []
  let version = 1
  const dep: ModuleBody = () => {
    if (version > 1) events.push('run:dep')
    return { value: `v${version}` }
  }
  const entry: ModuleBody = (hot) => {
    if (version > 1) events.push(`run:entry:${String(hot.data.generation)}`)
    hot.dispose((data) => {
      events.push('dispose:entry')
      hooks.dispose?.(data)
    })
    hot.accept((module) => {
      events.push(`accept:${(module as { value: string }).value}`)
      hooks.accept?.(module)
    })
    return runtime.initModule('dep')
  }
  runtime.importers.set('dep', new Set(['entry']))
  runtime.run('dep', dep)
  runtime.run('entry', entry)
  return {
    events,
    registerFactories() {
      version = 2
      runtime.factories.set('dep', dep)
      runtime.factories.set('entry', entry)
    },
  }
}
