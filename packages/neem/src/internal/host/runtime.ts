import type { MaybePromise } from '@nmtjs/common'

import type { NeemResolvedArtifact } from '../../public/artifact.ts'
import type {
  NeemRuntimeHostParams,
  NeemRuntimeServerRuntimeHealth,
  NeemRuntimeThreadHandle,
  NeemRuntimeThreadPlan,
  NeemRuntimeUpstream,
  NeemWorkerPoolHealth,
  NeemWorkerPoolState,
  NeemWorkerState,
} from '../../public/runtime.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { HostHooks } from '../plugins/hooks.ts'
import type { RecoveryOptions } from './recovery.ts'
import type { HostRunnerData } from './runner-protocol.ts'
import type { ThreadPlan } from './thread.ts'
import { callHostHook } from '../plugins/hooks.ts'
import { childLogger, runtimeLabel } from '../shared/logger.ts'
import { normalizeError, wait } from '../shared/utils.ts'
import { createRecoveryPolicy, getRecoveryDelay } from './recovery.ts'
import { HostRunner } from './runner.ts'
import { ThreadController } from './thread.ts'

export type RuntimeControllerOptions = {
  snapshot: RuntimeSnapshot
  runtimeName: string
  hooks: HostHooks
  recovery?: RecoveryOptions
  onFailure?: (error: Error, runtime: RuntimeController) => MaybePromise<void>
}

export class RuntimeController {
  private host: HostRunner | undefined
  private hostParams: NeemRuntimeHostParams | undefined
  private threads: readonly ThreadController[] = []
  private stopped = true
  private recoveryPromise: Promise<void> | undefined
  private restartAttempts = 0

  constructor(private options: RuntimeControllerOptions) {}

  get name(): string {
    return this.options.runtimeName
  }

  listThreads(): readonly ThreadController[] {
    return this.threads
  }

  getUpstreams(): readonly NeemRuntimeUpstream[] {
    return this.threads.flatMap((thread) => thread.getUpstreams())
  }

  getHealth(): NeemRuntimeServerRuntimeHealth {
    const pool = this.getPoolHealth()
    return {
      name: this.name,
      ready: pool.state === 'ready',
      pool,
      threads: this.threads.map((thread) => thread.getHealth()),
    }
  }

  async start(): Promise<void> {
    this.stopped = false
    const hostParams = this.createHostParams()
    this.hostParams = hostParams
    hostParams.logger.debug('Neem runtime starting')
    hostParams.logger.trace(
      {
        host: Boolean(hostParams.hostArtifact),
        defaultThreads: hostParams.defaultThreads.length,
      },
      'Neem runtime options',
    )

    try {
      await this.callRuntimeHook('runtime:start')
      this.host = this.createHostRunner(hostParams)
      await this.host?.start()
      const plan = await this.host?.plan()
      const threadPlans = resolveThreadTopology({
        snapshot: this.options.snapshot,
        runtimeName: this.name,
        requireThreads: !this.host,
        defaultThreads: hostParams.defaultThreads,
        plans: plan?.threads,
      })
      hostParams.logger.trace(
        {
          threads: threadPlans.map((plan) => ({
            name: plan.name,
            artifactId: plan.artifact.id,
            owner: plan.artifact.owner,
          })),
        },
        'Neem runtime thread topology',
      )
      this.threads = threadPlans.map(
        (plan, index) =>
          new ThreadController({
            snapshot: this.options.snapshot,
            runtimeName: this.name,
            plan,
            index,
            hooks: this.options.hooks,
            onFailure: (error, thread) =>
              this.handleThreadFailure(error, thread),
          }),
      )

      await Promise.all(this.threads.map((thread) => thread.start()))
      const upstreams = this.getUpstreams()
      await this.host?.callStart(this.getThreadHandles(), upstreams)
      await this.callRuntimeHook('runtime:ready', upstreams)
      hostParams.logger.debug('Neem runtime ready')
      hostParams.logger.trace(
        { threads: this.threads.length, upstreams: upstreams.length },
        'Neem runtime summary',
      )
    } catch (error) {
      const normalized = normalizeError(error)
      await this.callHostFail(normalized)
      await this.callRuntimeFailHook(normalized)
      await this.stop().catch((stopError) => {
        hostParams.logger.warn(
          new Error(`Runtime [${this.name}] cleanup failed`, {
            cause: normalizeError(stopError),
          }),
        )
      })
      throw normalized
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    const host = this.host
    const hostParams = this.hostParams
    const threads = this.threads
    const handles = this.getThreadHandles()
    this.host = undefined
    this.hostParams = undefined
    this.threads = []
    hostParams?.logger.debug('Neem runtime stopping')
    hostParams?.logger.trace(
      { threads: threads.length },
      'Neem runtime stop options',
    )

    let hostError: Error | undefined
    if (hostParams) {
      try {
        await host?.callStop(handles)
      } catch (error) {
        hostError = normalizeError(error)
      }
    }

    const threadResults = await Promise.allSettled(
      threads.map((thread) => thread.stop()),
    )
    await host?.shutdown().catch((error) => {
      hostError ??= normalizeError(error)
    })
    let hookError: Error | undefined
    if (hostParams) {
      await this.callRuntimeHook('runtime:stop').catch((error) => {
        hookError = normalizeError(error)
      })
    }
    hostParams?.logger.debug('Neem runtime stopped')

    const threadError = threadResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    if (hostError) throw hostError
    if (threadError) throw normalizeError(threadError.reason)
    if (hookError) throw hookError
  }

  replaceSnapshot(snapshot: RuntimeSnapshot): void {
    this.options = { ...this.options, snapshot }
  }

  private async handleThreadFailure(
    error: Error,
    thread: ThreadController,
  ): Promise<void> {
    this.hostParams?.logger.warn(
      { err: error },
      `Neem runtime worker ${thread.name} failed`,
    )
    this.hostParams?.logger.trace(
      { thread: thread.name },
      'Neem runtime worker failure',
    )
    await this.callHostFail(error)
    await this.callRuntimeFailHook(error)

    if (this.recoveryPromise) return

    const policy = createRecoveryPolicy(
      this.options.snapshot.mode,
      this.options.recovery,
    )
    if (policy.attempts === 0) {
      await this.options.onFailure?.(error, this)
      return
    }

    this.recoveryPromise = this.recover(error, thread).finally(() => {
      this.recoveryPromise = undefined
    })
    await this.recoveryPromise
  }

  private async handleHostFailure(error: Error): Promise<void> {
    this.hostParams?.logger.warn({ err: error }, 'Neem runtime host failed')
    await this.callRuntimeFailHook(error)

    if (this.recoveryPromise) return

    const policy = createRecoveryPolicy(
      this.options.snapshot.mode,
      this.options.recovery,
    )
    if (policy.attempts === 0) {
      await this.options.onFailure?.(error, this)
      return
    }

    this.recoveryPromise = this.recover(error).finally(() => {
      this.recoveryPromise = undefined
    })
    await this.recoveryPromise
  }

  private async recover(
    initialError: Error,
    thread?: ThreadController,
  ): Promise<void> {
    const policy = createRecoveryPolicy(
      this.options.snapshot.mode,
      this.options.recovery,
    )
    let lastError = initialError

    while (this.restartAttempts < policy.attempts) {
      const attempt = this.restartAttempts + 1
      this.restartAttempts = attempt
      const delayMs = getRecoveryDelay(policy, attempt)
      this.hostParams?.logger.warn(
        { err: lastError },
        `Restarting Neem runtime after failure (${attempt}/${policy.attempts})`,
      )
      this.hostParams?.logger.trace(
        { attempt, attempts: policy.attempts, delayMs },
        'Neem runtime recovery policy',
      )
      await wait(delayMs)
      if (this.stopped) return

      try {
        await this.stop()
        await this.start()
        this.restartAttempts = 0
        return
      } catch (error) {
        lastError = normalizeError(error)
      }
    }

    this.hostParams?.logger.error(
      { err: lastError },
      'Neem runtime recovery exhausted',
    )
    await this.options.onFailure?.(lastError, this)
  }

  private createHostRunner(
    hostParams: NeemRuntimeHostParams,
  ): HostRunner | undefined {
    const hostArtifact = resolveRuntimeArtifact(
      this.options.snapshot,
      this.name,
      'host',
    )
    if (!hostArtifact) return undefined

    return new HostRunner({
      data: this.createHostRunnerData(hostParams, hostArtifact),
      onFailure: (error) => this.handleHostFailure(error),
    })
  }

  private createHostRunnerData(
    hostParams: NeemRuntimeHostParams,
    hostArtifact: NeemResolvedArtifact,
  ): HostRunnerData {
    return {
      mode: this.options.snapshot.mode,
      runtimeName: this.name,
      options: hostParams.options,
      logger: this.options.snapshot.manifest.config.logger,
      outDir: this.options.snapshot.outDir,
      artifact: hostParams.artifact,
      hostArtifact,
      artifacts: this.options.snapshot.artifacts.list(),
      defaultThreads: hostParams.defaultThreads,
    }
  }

  private createHostParams(): NeemRuntimeHostParams {
    const owner = { type: 'runtime' as const, name: this.name }
    const artifact =
      resolveRuntimeArtifact(this.options.snapshot, this.name, 'entry') ??
      resolveRuntimeArtifact(this.options.snapshot, this.name, 'host')
    if (!artifact) {
      throw new Error(`Runtime [${this.name}] entry artifact is missing`)
    }

    return {
      mode: this.options.snapshot.mode,
      name: this.name,
      options: this.options.snapshot.config.runtimes[this.name]?.options,
      logger: childLogger(
        this.options.snapshot.logger,
        runtimeLabel(this.name),
      ),
      artifact,
      hostArtifact: resolveRuntimeArtifact(
        this.options.snapshot,
        this.name,
        'host',
      ),
      artifacts: this.options.snapshot.artifacts.scope(owner),
      defaultThreads: createDefaultThreadPlans(
        this.options.snapshot,
        this.name,
      ),
    }
  }

  private async callHostFail(error: Error): Promise<void> {
    try {
      await this.host?.callFail(error, this.getThreadHandles())
    } catch (failError) {
      this.hostParams?.logger.warn(
        new Error(`Runtime [${this.name}] fail handler failed`, {
          cause: normalizeError(failError),
        }),
      )
    }
  }

  private async callRuntimeFailHook(error: Error): Promise<void> {
    await this.callRuntimeHook('runtime:fail', undefined, error).catch(
      (hookError) => {
        this.hostParams?.logger.warn(
          new Error(`Runtime [${this.name}] fail hook failed`, {
            cause: normalizeError(hookError),
          }),
        )
      },
    )
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
    this.hostParams?.logger.trace(
      { hook: name, upstreams: upstreams?.length, err: error },
      'Neem runtime hook',
    )
    return callHostHook(
      this.options.hooks,
      this.options.snapshot.logger,
      name,
      { mode: this.options.snapshot.mode, name: this.name, upstreams, error },
    )
  }

  private getPoolHealth(): NeemWorkerPoolHealth {
    const states = this.threads.map((thread) => thread.getState())
    return {
      name: `runtime:${this.name}`,
      state: getPoolState(states),
      size: states.length,
      ready: states.filter((state) => state === 'ready').length,
      failed: states.filter((state) => state === 'failed').length,
      stopped: states.filter((state) => state === 'stopped').length,
      starting: states.filter((state) => state === 'starting').length,
    }
  }

  private getThreadHandles(): readonly NeemRuntimeThreadHandle[] {
    return this.threads.map((thread) => thread.getHandle())
  }
}

export function resolveRuntimeArtifact(
  snapshot: RuntimeSnapshot,
  runtimeName: string,
  artifactId: string,
): NeemResolvedArtifact | undefined {
  return snapshot.artifacts.resolveFor(
    { type: 'runtime', name: runtimeName },
    artifactId,
  )
}

export function createDefaultThreadPlans(
  snapshot: RuntimeSnapshot,
  runtimeName: string,
): readonly NeemRuntimeThreadPlan[] {
  const runtime = snapshot.config.runtimes[runtimeName]
  const entry = resolveRuntimeArtifact(snapshot, runtimeName, 'entry')
  const threads = runtime?.threads ?? (entry ? 1 : 0)

  if (typeof threads === 'number') {
    if (!Number.isInteger(threads) || threads < 0) {
      throw new Error(
        `Runtime [${runtimeName}] threads must be a non-negative integer`,
      )
    }
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

export function resolveThreadTopology(options: {
  snapshot: RuntimeSnapshot
  runtimeName: string
  requireThreads: boolean
  defaultThreads: readonly NeemRuntimeThreadPlan[]
  plans: readonly NeemRuntimeThreadPlan[] | undefined
}): readonly ThreadPlan[] {
  const source = options.plans ?? options.defaultThreads
  const expanded = source.flatMap((plan) => {
    const count = plan.count ?? 1
    if (!Number.isInteger(count) || count <= 0) {
      throw new Error(
        `Runtime [${options.runtimeName}] thread [${plan.name}] count must be a positive integer`,
      )
    }

    return Array.from({ length: count }, (_, index) => ({
      name: count > 1 ? `${plan.name}:${index}` : plan.name,
      artifact: resolveThreadArtifact(
        options.snapshot,
        options.runtimeName,
        plan,
      ),
      data: plan.data,
    }))
  })

  if (expanded.length === 0 && options.requireThreads) {
    throw new Error(
      `Runtime [${options.runtimeName}] must plan at least one thread`,
    )
  }

  const names = new Set<string>()
  for (const plan of expanded) {
    if (names.has(plan.name)) {
      throw new Error(
        `Runtime [${options.runtimeName}] has duplicate thread name [${plan.name}]`,
      )
    }
    names.add(plan.name)
  }

  return expanded
}

function resolveThreadArtifact(
  snapshot: RuntimeSnapshot,
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

function getPoolState(states: readonly NeemWorkerState[]): NeemWorkerPoolState {
  if (states.length === 0) return 'ready'
  if (states.every((state) => state === 'idle')) return 'idle'
  if (states.some((state) => state === 'starting')) return 'starting'
  if (states.some((state) => state === 'stopping')) return 'stopping'
  if (states.every((state) => state === 'stopped')) return 'stopped'
  if (states.every((state) => state === 'ready')) return 'ready'
  if (states.some((state) => state === 'ready')) return 'degraded'
  if (states.some((state) => state === 'failed')) return 'failed'
  return 'idle'
}
