import type { BindingClientHmrUpdate } from 'rolldown/experimental'
import pino from 'pino'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { HostControllerOptions } from '../../src/internal/host/controller.ts'
import type { RuntimePatchResult } from '../../src/internal/host/runtime.ts'
import type { WorkerServiceClientOptions } from '../../src/internal/services/client.ts'
import type {
  WatcherEvent,
  WatcherResult,
} from '../../src/internal/services/protocol.ts'
import { DevFreshness } from '../../src/internal/dev/freshness.ts'
import { DevSession } from '../../src/internal/dev/session.ts'

type Request = { type: string; runtimeName?: string; clientId?: string }

const state = vi.hoisted(() => ({
  watchers: [] as FakeWatcher[],
  controllers: [] as FakeController[],
  signals: [] as { close: ReturnType<typeof vi.fn> }[],
  // Whether the next ensure-worker-output request finds a build.
  outputBuilds: true,
}))

type FakeWatcher = {
  options: WorkerServiceClientOptions<WatcherEvent>
  requests: Request[]
  stop: ReturnType<typeof vi.fn>
  emit: (event: WatcherEvent) => void
}

type FakeController = {
  options: HostControllerOptions
  threadId: string
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  reloadRuntime: ReturnType<typeof vi.fn>
  applyPatch: ReturnType<typeof vi.fn<() => Promise<RuntimePatchResult>>>
}

const manifest = {
  manifestFile: '/out/neem.manifest.json',
  manifestRevision: 1,
  manifestHash: 'hash',
}

vi.mock('../../src/internal/services/client.ts', () => ({
  resolveServiceEntry: () => new URL('file:///watcher-entry.js'),
  WorkerServiceClient: class {
    options: WorkerServiceClientOptions<WatcherEvent>
    requests: Request[] = []
    stop = vi.fn(async () => {})
    constructor(options: WorkerServiceClientOptions<WatcherEvent>) {
      this.options = options
      state.watchers.push(this as unknown as FakeWatcher)
    }
    emit(event: WatcherEvent) {
      this.options.onEvent?.(event)
    }
    async request(command: Request): Promise<WatcherResult | undefined> {
      this.requests.push(command)
      switch (command.type) {
        case 'start':
          // The real watcher announces its first build before it answers.
          this.emit({ type: 'ready', ...manifest })
          return { manifestFile: manifest.manifestFile, configSignalFiles: [] }
        case 'ensure-worker-output':
          if (!state.outputBuilds) throw new Error('source has build errors')
          return { manifest }
      }
      return undefined
    }
  },
}))

vi.mock('../../src/internal/host/controller.ts', () => ({
  HostController: class {
    options: HostControllerOptions
    threadId = `api:${state.controllers.length}`
    start = vi.fn(async () => this.thread('thread-started'))
    stop = vi.fn(async () => this.thread('thread-stopped'))
    reloadRuntime = vi.fn(async () => {})
    applyPatch = vi.fn(
      async (): Promise<RuntimePatchResult> => ({
        outcome: 'applied',
        deliveredFiles: [],
      }),
    )
    constructor(options: HostControllerOptions) {
      this.options = options
      state.controllers.push(this as unknown as FakeController)
    }
    getHealth() {
      return { runtimes: [{ name: 'api', ready: true }] }
    }
    getSnapshot() {
      return { runtimeNames: ['api'] }
    }
    private thread(type: 'thread-started' | 'thread-stopped') {
      this.options.onThreadEvent?.({
        type,
        runtimeName: 'api',
        threadId: this.threadId,
      })
    }
  },
}))

vi.mock('../../src/internal/host/bootstrap.ts', () => ({
  loadRuntimeSnapshot: async () => ({ config: {} }),
}))

vi.mock('../../src/internal/manifest/manifest.ts', () => ({
  readManifest: async () => ({ config: {} }),
}))

vi.mock('../../src/internal/services/config-signal.ts', () => ({
  watchConfigSignal: async () => {
    const signal = { close: vi.fn(async () => {}) }
    state.signals.push(signal)
    return signal
  },
}))

vi.mock('../../src/internal/logger.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/internal/logger.ts')>()),
  createDefaultLogger: () => pino({ level: 'silent' }),
  resolveManifestLogger: async () => pino({ level: 'silent' }),
}))

afterEach(() => {
  state.watchers.length = 0
  state.controllers.length = 0
  state.signals.length = 0
  state.outputBuilds = true
})

describe('DevFreshness', () => {
  it('keeps the covering deferral and settles what a restart covers', () => {
    const freshness = new DevFreshness()
    freshness.markStale('api')
    freshness.defer('api', 'reload')
    freshness.defer('api', 'recovery')
    expect(freshness.resumable('api')).toBe('reload')

    // A recovery does not settle a deferred reload; a reload settles both.
    freshness.resume('api', 'recovery')
    expect(freshness.resumable('api')).toBe('reload')
    freshness.resume('api', 'reload')
    expect(freshness.resumable('api')).toBeUndefined()
  })

  it('resumes only for stale output, and a deferred host restart for any stale runtime', () => {
    const freshness = new DevFreshness()
    freshness.defer('api', 'recovery')
    expect(freshness.resumable('api')).toBeUndefined()

    freshness.markStale('api')
    freshness.markStale('aux')
    freshness.defer('aux', 'restart')
    expect(freshness.resumable('api')).toBe('restart')
    expect(freshness.staleRuntimes()).toEqual(['api', 'aux'])

    // A reload leaves the session-wide restart in place.
    freshness.resume('aux', 'reload')
    expect(freshness.resumable('aux')).toBe('restart')

    freshness.outputRefreshed('api')
    expect(freshness.resumable('api')).toBeUndefined()
    freshness.restarted()
    expect(freshness.resumable('aux')).toBeUndefined()
    expect(freshness.isStale('aux')).toBe(true)

    freshness.reset()
    expect(freshness.staleRuntimes()).toEqual([])
  })
})

describe('DevSession', () => {
  it('restarts only the watcher after it crashes and the host from its build', async () => {
    const { session, probe } = await startSession()
    const [first] = state.watchers
    const [running] = state.controllers

    first!.options.onFailure?.(new Error('watcher crashed'))
    // The dead worker also reports its exit; one restart covers both.
    first!.options.onFailure?.(new Error('exited with code [1]'))

    await vi.waitFor(() => expect(state.controllers).toHaveLength(2))
    const second = state.watchers[1]!
    await vi.waitFor(() =>
      expect(second.requests).toContainEqual(
        expect.objectContaining({
          type: 'patch-client-started',
          clientId: 'api:1',
        }),
      ),
    )
    expect(state.watchers).toHaveLength(2)
    expect(first!.stop).toHaveBeenCalled()
    expect(running!.stop).toHaveBeenCalled()
    expect(probe.emit).toHaveBeenCalledWith('watcher:restarted')
    // Output of the dead watcher is not trusted; the retired thread was never
    // the new watcher's client.
    expect(second.requests.map((request) => request.type)).toEqual([
      'start',
      'ensure-worker-output',
      'patch-client-started',
    ])
    await expectOpen(session)
  })

  it('recovers a runtime whose patch left no generation from refreshed output', async () => {
    const { session, probe } = await startSession()
    const [controller] = state.controllers
    controller!.applyPatch.mockResolvedValueOnce({
      outcome: 'unavailable',
      reason: 'failed to apply patch: Error: setup failed',
      deliveredFiles: ['patch.js'],
    })

    state.watchers[0]!.emit(workerPatch('api:0'))
    await vi.waitFor(() =>
      expect(probe.emit).toHaveBeenCalledWith('runtime:patch-unavailable', {
        runtimeName: 'api',
        reason: 'failed to apply patch: Error: setup failed',
      }),
    )
    expect(controller!.reloadRuntime).not.toHaveBeenCalled()

    // Host recovery waits for output that includes the retired patch.
    state.outputBuilds = false
    const recovery = controller!.options.prepareRecovery!('api')
    const released = vi.fn()
    void recovery.then(released)
    await vi.waitFor(() =>
      expect(probe.emit).toHaveBeenCalledWith('runtime:restart-deferred', {
        runtimeName: 'api',
      }),
    )
    expect(released).not.toHaveBeenCalled()

    state.outputBuilds = true
    state.watchers[0]!.emit(workerPatch('api:0'))
    await recovery
    expect(controller!.applyPatch).toHaveBeenCalledOnce()
    expect(controller!.reloadRuntime).not.toHaveBeenCalled()
    await expectOpen(session)
  })

  it('keeps running after a runtime failure and restarts it on the next build', async () => {
    const { session, probe } = await startSession()
    const [controller] = state.controllers

    controller!.options.onFailure?.(new Error('recovery exhausted'), 'api')
    expect(probe.emit).toHaveBeenCalledWith(
      'runtime:error',
      expect.objectContaining({ runtimeName: 'api' }),
    )

    state.watchers[0]!.emit(workerPatch('api:0'))
    await vi.waitFor(() =>
      expect(controller!.reloadRuntime).toHaveBeenCalledOnce(),
    )
    expect(controller!.applyPatch).not.toHaveBeenCalled()
    expect(state.watchers[0]!.requests).toContainEqual({
      type: 'ensure-worker-output',
      runtimeName: 'api',
    })
    await expectOpen(session)
  })
})

async function startSession() {
  const probe = { emit: vi.fn() }
  const abort = new AbortController()
  const session = new DevSession({
    configFile: '/app/neem.config.ts',
    outDir: '/out',
    signal: abort.signal,
    probe,
  })
  await session.start()
  await vi.waitFor(() =>
    expect(state.watchers[0]?.requests).toContainEqual(
      expect.objectContaining({ type: 'patch-client-started' }),
    ),
  )
  return { session, probe }
}

function workerPatch(clientId: string): WatcherEvent {
  const update = {
    type: 'Patch',
    filename: 'patch.js',
  } as unknown as BindingClientHmrUpdate['update']
  return {
    type: 'worker-patch',
    runtimeName: 'api',
    updates: [{ clientId, update }],
  }
}

// The session is still serving: stopping it now is its first outcome.
async function expectOpen(session: DevSession) {
  const closed = vi.fn()
  session.closed.then(closed, closed)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(closed).not.toHaveBeenCalled()
  await session.stop()
}
