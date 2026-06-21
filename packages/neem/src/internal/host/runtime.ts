import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from '@nmtjs/core'

import type {
  NeemResolvedArtifact,
  NeemRuntimePlan,
  NeemRuntimeServerRuntimeHealth,
  NeemRuntimeUpstream,
  NeemWorkerPoolHealth,
  NeemWorkerPoolState,
  NeemWorkerState,
} from '../../shared/types.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { HostHooks } from '../plugins/hooks.ts'
import type { RecoveryOptions } from './recovery.ts'
import type { HostRunnerData } from './runner-protocol.ts'
import type { ThreadPlan } from './thread.ts'
import { childLogger, runtimeLabel } from '../logger.ts'
import { callHostHook } from '../plugins/hooks.ts'
import { normalizeError, wait } from '../utils.ts'
import { createRuntimeEnv } from './env.ts'
import { createRecoveryPolicy, getRecoveryDelay } from './recovery.ts'
import { HostRunner } from './runner.ts'
import { ThreadController } from './thread.ts'

export type RuntimeControllerOptions = {
  snapshot: RuntimeSnapshot
  runtimeName: string
  hooks: HostHooks
  recovery?: RecoveryOptions
  onFailure?: (error: Error, runtime: RuntimeController) => MaybePromise<void>
  onRecovered?: (runtime: RuntimeController) => MaybePromise<void>
}

export class RuntimeController {
  private host: HostRunner | undefined
  private logger: Logger | undefined
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
    const logger = this.createLogger()
    this.logger = logger
    logger.debug('Neem runtime starting')

    try {
      await this.callRuntimeHook('runtime:start')
      const host = this.createHostRunner()
      this.host = host
      await host.start()
      const plan = await host.plan()
      const threadPlans = resolveThreadTopology({
        snapshot: this.options.snapshot,
        runtimeName: this.name,
        plan,
      })
      logger.trace(
        {
          threads: threadPlans.map((thread) => ({
            name: thread.name,
            artifactId: thread.artifact.id,
          })),
        },
        'Neem runtime worker topology',
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
      await host.callStart(this.getThreadHandles())
      await this.callRuntimeHook('runtime:ready', this.getUpstreams())
      logger.debug('Neem runtime ready')
      logger.trace(
        { threads: this.threads.length, upstreams: this.getUpstreams().length },
        'Neem runtime summary',
      )
    } catch (error) {
      const normalized = normalizeError(error)
      await this.callRuntimeFailHook(normalized)
      await this.stop().catch((stopError) => {
        logger.warn(
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
    const threads = this.threads
    const logger = this.logger
    this.host = undefined
    this.threads = []
    this.logger = undefined
    logger?.debug('Neem runtime stopping')
    logger?.trace({ threads: threads.length }, 'Neem runtime stop options')

    let hostError: Error | undefined
    try {
      await host?.callStop()
    } catch (error) {
      hostError = normalizeError(error)
    }

    const threadResults = await Promise.allSettled(
      threads.map((thread) => thread.stop()),
    )
    await host?.shutdown().catch((error) => {
      hostError ??= normalizeError(error)
    })

    let hookError: Error | undefined
    if (logger) {
      await this.callRuntimeHook('runtime:stop').catch((error) => {
        hookError = normalizeError(error)
      })
    }
    logger?.debug('Neem runtime stopped')

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
    this.logger?.warn(
      { err: error },
      `Neem runtime worker ${thread.name} failed`,
    )
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

  private async handleHostFailure(error: Error): Promise<void> {
    this.logger?.warn({ err: error }, 'Neem runtime host failed')
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

  private async recover(initialError: Error): Promise<void> {
    const policy = createRecoveryPolicy(
      this.options.snapshot.mode,
      this.options.recovery,
    )
    let lastError = initialError

    while (this.restartAttempts < policy.attempts) {
      const attempt = this.restartAttempts + 1
      this.restartAttempts = attempt
      const delayMs = getRecoveryDelay(policy, attempt)
      this.logger?.warn(
        { err: lastError },
        `Restarting Neem runtime after failure (${attempt}/${policy.attempts})`,
      )
      await wait(delayMs)
      if (this.stopped) return

      try {
        await this.stop()
        await this.start()
        await this.options.onRecovered?.(this)
        this.restartAttempts = 0
        return
      } catch (error) {
        lastError = normalizeError(error)
      }
    }

    this.logger?.error({ err: lastError }, 'Neem runtime recovery exhausted')
    await this.options.onFailure?.(lastError, this)
  }

  private createHostRunner(): HostRunner {
    return new HostRunner({
      data: this.createHostRunnerData(),
      env: this.createRuntimeEnv(),
      onFailure: (error) => this.handleHostFailure(error),
    })
  }

  private createRuntimeEnv(): NodeJS.ProcessEnv {
    return createRuntimeEnv({
      manifest: this.options.snapshot.manifest,
      runtimeName: this.name,
      overrideEnv: this.options.snapshot.env,
    })
  }

  private createHostRunnerData(): HostRunnerData {
    return {
      mode: this.options.snapshot.mode,
      runtimeName: this.name,
      logger: this.options.snapshot.manifest.config.logger,
      outDir: this.options.snapshot.outDir,
      hostArtifact: resolveRequiredRuntimeArtifact(
        this.options.snapshot,
        this.name,
        'host',
      ),
      plannerArtifact: resolveRequiredRuntimeArtifact(
        this.options.snapshot,
        this.name,
        'planner',
      ),
    }
  }

  private createLogger(): Logger {
    return childLogger(this.options.snapshot.logger, runtimeLabel(this.name))
  }

  private async callRuntimeFailHook(error: Error): Promise<void> {
    await this.callRuntimeHook('runtime:fail', undefined, error).catch(
      (hookError) => {
        this.logger?.warn(
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
    this.logger?.trace(
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

  private getThreadHandles() {
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

export function resolveRequiredRuntimeArtifact(
  snapshot: RuntimeSnapshot,
  runtimeName: string,
  artifactId: string,
): NeemResolvedArtifact {
  const artifact = resolveRuntimeArtifact(snapshot, runtimeName, artifactId)
  if (!artifact) {
    throw new Error(
      `Runtime [${runtimeName}] artifact [${artifactId}] is missing`,
    )
  }
  return artifact
}

export function resolveThreadTopology(options: {
  snapshot: RuntimeSnapshot
  runtimeName: string
  plan: NeemRuntimePlan | undefined
}): readonly ThreadPlan[] {
  const workerArtifact = resolveRuntimeArtifact(
    options.snapshot,
    options.runtimeName,
    'worker',
  )
  const workers = options.plan?.workers ?? []
  const plans = normalizePlannedWorkers(options.runtimeName, workers)

  if (plans.length > 0 && !workerArtifact) {
    throw new Error(
      `Runtime [${options.runtimeName}] planned workers but has no worker artifact`,
    )
  }

  return plans.map((plan) => ({
    name: plan.name,
    artifact: workerArtifact!,
    data: plan.data,
  }))
}

function normalizePlannedWorkers(
  runtimeName: string,
  workers: unknown,
): readonly { name: string; data: unknown }[] {
  if (Array.isArray(workers)) {
    return workers.map((data, index) => {
      assertStructuredCloneable(runtimeName, `${runtimeName}:${index}`, data)
      return { name: `${runtimeName}:${index}`, data }
    })
  }

  if (!isGroupedWorkerPlan(workers)) {
    throw new Error(
      `Runtime [${runtimeName}] planner workers must be an array or record of arrays`,
    )
  }

  return Object.entries(workers).flatMap(([group, groupWorkers]) =>
    groupWorkers.map((data, index) => {
      const name = `${runtimeName}:${group}:${index}`
      assertStructuredCloneable(runtimeName, name, data)
      return { name, data }
    }),
  )
}

function isGroupedWorkerPlan(
  workers: unknown,
): workers is Record<string, readonly unknown[]> {
  if (typeof workers !== 'object' || workers === null) return false
  return Object.values(workers).every((group) => Array.isArray(group))
}

function assertStructuredCloneable(
  runtimeName: string,
  workerName: string,
  data: unknown,
): void {
  try {
    structuredClone(data)
  } catch (error) {
    throw new Error(
      `Runtime [${runtimeName}] worker [${workerName}] data must be structured-cloneable`,
      { cause: normalizeError(error) },
    )
  }
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
