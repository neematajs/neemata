import type { MessagePort } from 'node:worker_threads'
import { MessageChannel } from 'node:worker_threads'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  NeemRuntimeHost,
  NeemRuntimeHostFactory,
  NeemRuntimeHostParams,
  NeemRuntimeThreadHandle,
  NeemRuntimeThreadPlan,
  NeemRuntimeUpstream,
  NeemWorkerState,
} from '../../public/runtime.ts'
import type { NeemHostHooks } from './hooks.ts'
import type {
  NeemManagedWorkerController,
  NeemManagedWorkerHealth,
} from './managed-worker.ts'
import type { NeemProxyUpstreamRegistry } from './proxy-upstreams.ts'
import type { NeemRuntimeRecoveryOptions } from './recovery.ts'
import type { NeemRuntimeSnapshot } from './snapshot.ts'
import type {
  NeemWorkerPoolHealth,
  NeemWorkerPoolState,
} from './worker-pool.ts'
import type {
  NeemRuntimeWorkerData,
  NeemRuntimeWorkerErrorMessage,
  NeemRuntimeWorkerMessage,
} from './worker-protocol.ts'
import { callNeemHostHook } from './hooks.ts'
import { createNeemChildLogger, createNeemRuntimeLabel } from './logger.ts'
import { NeemManagedWorker } from './managed-worker.ts'
import {
  createRuntimeRecoveryPolicy,
  getRuntimeRecoveryDelay,
} from './recovery.ts'
import { importDefault } from './utils.ts'
import { NeemWorkerPool } from './worker-pool.ts'
import { resolveRuntimeWorkerEntry } from './worker-runtime.ts'

export type NeemStartedRuntimeThread = NeemRuntimeThreadHandle & {
  runtimeName: string
  artifact: NeemResolvedArtifact
  getHealth: () => NeemStartedRuntimeThreadHealth
  getUpstreams: () => readonly NeemRuntimeUpstream[]
}

export type NeemStartedRuntimeThreadHealth = NeemManagedWorkerHealth & {
  runtimeName: string
  artifact: NeemResolvedArtifact
  upstreams: readonly NeemRuntimeUpstream[]
}

export type NeemStartedRuntimePool = {
  runtimeName: string
  name: string
  list: () => readonly NeemStartedRuntimeThread[]
  getState: () => NeemWorkerPoolState
  getHealth: () => NeemWorkerPoolHealth
}

export type NeemRuntimeManagerOptions = {
  snapshot: NeemRuntimeSnapshot
  proxyUpstreams: NeemProxyUpstreamRegistry
  hooks: NeemHostHooks
  recovery?: NeemRuntimeRecoveryOptions
  onWorkerFailure?: (
    error: Error,
    worker: NeemStartedRuntimeThread,
  ) => void | Promise<void>
}

export class NeemRuntimeManager {
  private readonly runtimes = new Map<string, NeemRuntimeHostRuntime>()

  constructor(private readonly options: NeemRuntimeManagerOptions) {
    for (const runtimeName of Object.keys(
      options.snapshot.manifest.runtimes ?? {},
    )) {
      this.runtimes.set(
        runtimeName,
        new NeemRuntimeHostRuntime({
          runtimeName,
          snapshot: options.snapshot,
          proxyUpstreams: options.proxyUpstreams,
          hooks: options.hooks,
          onWorkerFailure: options.onWorkerFailure,
        }),
      )
    }
  }

  *listThreads(): IterableIterator<NeemStartedRuntimeThread> {
    for (const runtime of this.runtimes.values()) {
      yield* runtime.listThreads()
    }
  }

  *listPools(): IterableIterator<NeemStartedRuntimePool> {
    for (const runtime of this.runtimes.values()) {
      yield* runtime.listPools()
    }
  }

  async start(): Promise<void> {
    try {
      await Promise.all(
        [...this.runtimes.values()].map((runtime) => runtime.start()),
      )
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => runtime.stop()),
    )
    this.runtimes.clear()
  }

  async reloadRuntime(
    runtimeName: string,
    snapshot: NeemRuntimeSnapshot,
  ): Promise<void> {
    const current = this.runtimes.get(runtimeName)
    await current?.stop()
    this.runtimes.delete(runtimeName)

    if (!snapshot.manifest.runtimes?.[runtimeName]) {
      await callRuntimeReloadHook({
        hooks: this.options.hooks,
        snapshot,
        runtimeName,
        upstreams: [],
      })
      return
    }

    const next = new NeemRuntimeHostRuntime({
      ...this.options,
      snapshot,
      runtimeName,
    })
    this.runtimes.set(runtimeName, next)

    try {
      await next.start()
      const upstreams: NeemRuntimeUpstream[] = []
      for (const thread of next.listThreads()) {
        upstreams.push(...thread.getUpstreams())
      }
      await callRuntimeReloadHook({
        hooks: this.options.hooks,
        snapshot,
        runtimeName,
        upstreams,
      })
    } catch (error) {
      this.runtimes.delete(runtimeName)
      await next.stop().catch(() => undefined)
      throw error
    }
  }
}

type NeemRuntimeHostRuntimeOptions = NeemRuntimeManagerOptions & {
  runtimeName: string
}

class NeemRuntimeHostRuntime {
  private host: NeemRuntimeHost | undefined
  private hostParams: NeemRuntimeHostParams | undefined
  private pools: readonly NeemRuntimeThreadPool[] = []
  private threads: readonly NeemRuntimeThread[] = []
  private stopped = true
  private recoveryPromise: Promise<void> | undefined
  private restartAttempts = 0

  constructor(private readonly options: NeemRuntimeHostRuntimeOptions) {}

  *listThreads(): IterableIterator<NeemStartedRuntimeThread> {
    yield* this.threads
  }

  *listPools(): IterableIterator<NeemStartedRuntimePool> {
    yield* this.pools
  }

  async start(): Promise<void> {
    const { snapshot, runtimeName } = this.options
    this.stopped = false
    const hostParams = this.createHostParams()
    let host: NeemRuntimeHost | undefined
    this.hostParams = hostParams

    try {
      await this.callRuntimeHook('runtime:start')
      const hostFactory = await this.loadHost()
      host = await hostFactory?.(hostParams)
      this.host = host
      const plan = host?.plan
        ? await host.plan()
        : { threads: createDefaultRuntimeThreadPlans(snapshot, runtimeName) }

      this.threads = createRuntimeThreads({
        snapshot,
        runtimeName,
        plans: plan.threads ?? [],
        hooks: this.options.hooks,
        onWorkerFailure: (error, worker) => {
          void this.handleWorkerFailure(error, worker).catch((failureError) => {
            hostParams.logger.warn(
              new Error(
                `Runtime [${runtimeName}] worker failure handler failed`,
                { cause: toError(failureError) },
              ),
            )
          })
        },
      })
      this.pools = createRuntimeThreadPools(snapshot, runtimeName, this.threads)

      await Promise.all(this.pools.map((pool) => pool.start()))
      const upstreams = this.threads.flatMap((thread) => thread.getUpstreams())
      for (const thread of this.threads) {
        this.options.proxyUpstreams.addOwnerUpstreams(
          thread,
          runtimeName,
          thread.getUpstreams(),
        )
      }
      await host?.start?.({ threads: this.threads, upstreams })
      await this.callRuntimeHook('runtime:ready', upstreams)
    } catch (error) {
      const normalized = toError(error)
      await this.callHostFail(host, hostParams, normalized)
      await this.callRuntimeHook('runtime:fail', undefined, normalized)
      await this.stop().catch((stopError) => {
        hostParams.logger.warn(
          new Error(`Runtime [${runtimeName}] cleanup failed`, {
            cause: toError(stopError),
          }),
        )
      })
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    const threads = this.threads
    const host = this.host
    const hostParams = this.hostParams
    this.host = undefined
    this.hostParams = undefined
    this.threads = []
    this.pools = []

    let stopError: Error | undefined
    if (hostParams) {
      try {
        await host?.stop?.({ threads })
      } catch (error) {
        stopError = toError(error)
      }
    }

    for (const thread of threads) {
      this.options.proxyUpstreams.removeOwnerUpstreams(thread)
    }
    const threadResults = await Promise.allSettled(
      threads.map((thread) => thread.stop()),
    )
    if (hostParams) await this.callRuntimeHook('runtime:stop')

    const threadError = threadResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (stopError) throw stopError
    if (threadError) throw toError(threadError.reason)
  }

  private callRuntimeHook(name: 'runtime:start' | 'runtime:stop'): Promise<void>
  private callRuntimeHook(
    name: 'runtime:ready',
    upstreams: readonly NeemRuntimeUpstream[],
  ): Promise<void>
  private callRuntimeHook(
    name: 'runtime:fail',
    upstreams: undefined,
    error: Error,
  ): Promise<void>
  private callRuntimeHook(
    name: 'runtime:start' | 'runtime:ready' | 'runtime:stop' | 'runtime:fail',
    upstreams?: readonly NeemRuntimeUpstream[],
    error?: Error,
  ): Promise<void> {
    return callNeemHostHook(
      this.options.hooks,
      this.options.snapshot.logger,
      name,
      {
        mode: this.options.snapshot.mode,
        name: this.options.runtimeName,
        upstreams,
        error,
      },
    )
  }

  private async loadHost(): Promise<NeemRuntimeHostFactory | undefined> {
    const artifact = resolveRuntimeArtifact(
      this.options.snapshot,
      this.options.runtimeName,
      'host',
    )
    if (!artifact) return undefined

    return importDefault<NeemRuntimeHostFactory>(artifact.file)
  }

  private createHostParams(): NeemRuntimeHostParams {
    const { snapshot, runtimeName } = this.options
    const owner = { type: 'runtime' as const, name: runtimeName }
    const artifact = resolveRuntimeArtifact(snapshot, runtimeName, 'entry')
    if (!artifact) {
      throw new Error(`Runtime [${runtimeName}] entry artifact is missing`)
    }

    return {
      mode: snapshot.mode,
      name: runtimeName,
      options: snapshot.config.runtimes?.[runtimeName]?.options,
      logger: createNeemChildLogger(
        snapshot.logger,
        createNeemRuntimeLabel(runtimeName),
      ),
      artifact,
      hostArtifact: resolveRuntimeArtifact(snapshot, runtimeName, 'host'),
      artifacts: snapshot.artifacts.scope(owner),
    }
  }

  private async callHostFail(
    host: NeemRuntimeHost | undefined,
    hostParams: NeemRuntimeHostParams,
    error: Error,
  ): Promise<void> {
    try {
      await host?.fail?.({ error, threads: this.threads })
    } catch (failError) {
      hostParams.logger.warn(
        new Error(`Runtime [${this.options.runtimeName}] fail handler failed`, {
          cause: toError(failError),
        }),
      )
    }
  }

  private async handleWorkerFailure(
    error: Error,
    worker: NeemStartedRuntimeThread,
  ): Promise<void> {
    const host = this.host
    const hostParams = this.hostParams

    if (hostParams) {
      await this.callHostFail(host, hostParams, error)
      await this.callRuntimeHook('runtime:fail', undefined, error)
    }

    if (this.recoveryPromise) return

    const policy = createRuntimeRecoveryPolicy(
      this.options.snapshot.mode,
      this.options.recovery,
    )
    if (policy.attempts === 0) {
      await this.options.onWorkerFailure?.(error, worker)
      return
    }

    this.recoveryPromise = this.recoverWorkerFailure(error, worker).finally(
      () => {
        this.recoveryPromise = undefined
      },
    )
    await this.recoveryPromise
  }

  private async recoverWorkerFailure(
    initialError: Error,
    worker: NeemStartedRuntimeThread,
  ): Promise<void> {
    const policy = createRuntimeRecoveryPolicy(
      this.options.snapshot.mode,
      this.options.recovery,
    )
    let lastError = initialError

    while (this.restartAttempts < policy.attempts) {
      const attempt = this.restartAttempts + 1
      const delayMs = getRuntimeRecoveryDelay(policy, attempt)
      this.hostParams?.logger.warn(
        {
          runtimeName: this.options.runtimeName,
          worker: worker.name,
          attempt,
          attempts: policy.attempts,
          delayMs,
        },
        'Restarting Neem runtime after worker failure',
      )
      this.restartAttempts = attempt
      await wait(delayMs)
      if (this.stopped) return

      try {
        await this.stop()
        await this.start()
        return
      } catch (error) {
        lastError = toError(error)
      }
    }

    await this.options.onWorkerFailure?.(lastError, worker)
  }
}

function resolveRuntimeArtifact(
  snapshot: NeemRuntimeSnapshot,
  runtimeName: string,
  artifactId: string,
): NeemResolvedArtifact | undefined {
  return snapshot.artifacts.list().find((artifact) => {
    return (
      artifact.id === artifactId &&
      artifact.owner.type === 'runtime' &&
      artifact.owner.name === runtimeName
    )
  })
}

function createDefaultRuntimeThreadPlans(
  snapshot: NeemRuntimeSnapshot,
  runtimeName: string,
): readonly NeemRuntimeThreadPlan[] {
  const config = snapshot.config.runtimes?.[runtimeName]
  const threads = config?.threads ?? 1

  if (typeof threads === 'number') {
    return Array.from({ length: threads }, (_, index) => ({
      name: `${runtimeName}:${index}`,
      artifact: 'entry',
      data: {},
    }))
  }

  return threads.map((data, index) => ({
    name: `${runtimeName}:${index}`,
    artifact: 'entry',
    data,
  }))
}

function createRuntimeThreads(options: {
  snapshot: NeemRuntimeSnapshot
  runtimeName: string
  plans: readonly NeemRuntimeThreadPlan[]
  hooks: NeemHostHooks
  onWorkerFailure?: (
    error: Error,
    worker: NeemStartedRuntimeThread,
  ) => void | Promise<void>
}): readonly NeemRuntimeThread[] {
  let index = 0
  return options.plans.flatMap((plan) => {
    const artifact = resolveThreadPlanArtifact(
      options.snapshot,
      options.runtimeName,
      plan,
    )

    return Array.from({ length: plan.count ?? 1 }, (_, threadIndex) => {
      return new NeemRuntimeThread({
        snapshot: options.snapshot,
        runtimeName: options.runtimeName,
        plan: {
          ...plan,
          name:
            (plan.count ?? 1) > 1 ? `${plan.name}:${threadIndex}` : plan.name,
        },
        index: index++,
        artifact,
        hooks: options.hooks,
        onWorkerFailure: options.onWorkerFailure,
      })
    })
  })
}

function resolveThreadPlanArtifact(
  snapshot: NeemRuntimeSnapshot,
  runtimeName: string,
  plan: NeemRuntimeThreadPlan,
): NeemResolvedArtifact {
  if (typeof plan.artifact !== 'string') return plan.artifact

  const artifact = resolveRuntimeArtifact(snapshot, runtimeName, plan.artifact)
  if (!artifact) {
    throw new Error(
      `Runtime [${runtimeName}] thread artifact [${plan.artifact}] is missing`,
    )
  }

  return artifact
}

function createRuntimeThreadPools(
  snapshot: NeemRuntimeSnapshot,
  runtimeName: string,
  threads: readonly NeemRuntimeThread[],
): readonly NeemRuntimeThreadPool[] {
  return [
    new NeemRuntimeThreadPool({
      runtimeName,
      workers: threads,
      logger: snapshot.logger,
    }),
  ]
}

class NeemRuntimeThread implements NeemStartedRuntimeThread {
  readonly id: string
  readonly runtimeName: string
  readonly name: string
  readonly artifactId: string
  readonly artifact: NeemResolvedArtifact
  readonly port: MessagePort

  private readonly worker: NeemManagedWorker
  private upstreams: readonly NeemRuntimeUpstream[] = []

  constructor(
    private readonly options: {
      snapshot: NeemRuntimeSnapshot
      runtimeName: string
      plan: NeemRuntimeThreadPlan
      index: number
      artifact: NeemResolvedArtifact
      hooks: NeemHostHooks
      onWorkerFailure?: (
        error: Error,
        worker: NeemStartedRuntimeThread,
      ) => void | Promise<void>
    },
  ) {
    const channel = new MessageChannel()
    this.port = channel.port1
    this.runtimeName = options.runtimeName
    this.name = options.plan.name
    this.id = `${options.runtimeName}:${options.plan.name}:${options.index}`
    this.artifact = options.artifact
    this.artifactId = options.artifact.id

    const workerData: NeemRuntimeWorkerData = {
      mode: options.snapshot.mode,
      runtimeName: options.runtimeName,
      name: this.name,
      data: options.plan.data ?? {},
      artifact: options.artifact,
      artifacts: options.snapshot.artifacts.list(),
      configFile: options.snapshot.configFile,
      outDir: options.snapshot.outDir,
      logger: options.snapshot.manifest.config.logger,
      port: channel.port2,
    }

    this.worker = new NeemManagedWorker({
      id: this.id,
      name: this.name,
      artifactId: this.artifactId,
      entry: options.snapshot.runtimeWorkerEntry ?? resolveRuntimeWorkerEntry(),
      workerData,
      workerOptions: { transferList: [channel.port2] },
      logger: createNeemChildLogger(
        options.snapshot.logger,
        createNeemRuntimeLabel(options.runtimeName, options.plan.name),
      ),
      onMessage: (message, host) => {
        this.handleMessage(message as NeemRuntimeWorkerMessage, host)
      },
      onFailure: (error) => {
        void this.callWorkerHook('worker:fail', error)
        void options.onWorkerFailure?.(error, this)
      },
    })
  }

  getState(): NeemWorkerState {
    return this.worker.getState()
  }

  getHealth(): NeemStartedRuntimeThreadHealth {
    return {
      ...this.worker.getHealth(),
      runtimeName: this.runtimeName,
      artifact: this.artifact,
      upstreams: this.upstreams,
    }
  }

  getUpstreams(): readonly NeemRuntimeUpstream[] {
    return this.upstreams
  }

  async start(): Promise<void> {
    await this.callWorkerHook('worker:start')
    try {
      await this.worker.start()
      await this.callWorkerHook('worker:ready')
    } catch (error) {
      await this.callWorkerHook('worker:fail', toError(error))
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.worker.stop().finally(() => {
      this.port.close()
      this.upstreams = []
    })
    await this.callWorkerHook('worker:stop')
  }

  private handleMessage(
    message: NeemRuntimeWorkerMessage,
    controller: NeemManagedWorkerController,
  ) {
    if (message.type === 'ready') {
      this.upstreams = message.data.upstreams ?? []
      controller.markReady()
      return
    }

    if (message.type === 'error') {
      controller.fail(deserializeWorkerError(message.data))
      return
    }

    if (message.type === 'stopped') {
      controller.markStopped()
    }
  }

  private callWorkerHook(
    name: 'worker:start' | 'worker:ready' | 'worker:stop',
  ): Promise<void>
  private callWorkerHook(name: 'worker:fail', error: Error): Promise<void>
  private callWorkerHook(
    name: 'worker:start' | 'worker:ready' | 'worker:stop' | 'worker:fail',
    error?: Error,
  ): Promise<void> {
    return callNeemHostHook(
      this.options.hooks,
      this.options.snapshot.logger,
      name,
      {
        mode: this.options.snapshot.mode,
        id: this.id,
        name: this.name,
        artifactId: this.artifact.id,
        owner: this.artifact.owner,
        error,
      },
    )
  }
}

class NeemRuntimeThreadPool
  extends NeemWorkerPool<NeemRuntimeThread>
  implements NeemStartedRuntimePool
{
  readonly runtimeName: string

  constructor(options: {
    runtimeName: string
    workers: readonly NeemRuntimeThread[]
    logger: NeemRuntimeSnapshot['logger']
  }) {
    super({
      name: `runtime:${options.runtimeName}`,
      workers: options.workers,
      logger: options.logger,
    })
    this.runtimeName = options.runtimeName
  }
}

function deserializeWorkerError(
  data: NeemRuntimeWorkerErrorMessage['data'],
): Error {
  const error = new Error(data.message)
  error.name = data.name ?? error.name
  error.stack = data.stack
  return error
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function callRuntimeReloadHook(options: {
  hooks: NeemHostHooks
  snapshot: NeemRuntimeSnapshot
  runtimeName: string
  upstreams: readonly NeemRuntimeUpstream[]
}): Promise<void> {
  return callNeemHostHook(
    options.hooks,
    options.snapshot.logger,
    'runtime:reload',
    {
      mode: options.snapshot.mode,
      name: options.runtimeName,
      upstreams: options.upstreams,
    },
  )
}
