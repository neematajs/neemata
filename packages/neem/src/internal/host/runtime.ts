import type { MaybePromise } from '@nmtjs/common'
import type { Logger } from 'pino'

import type {
  NeemResolvedArtifact,
  NeemRuntimePlan,
  NeemRuntimeServerRuntimeHealth,
  NeemRuntimeState,
  NeemRuntimeUpstream,
  NeemWorkerPoolHealth,
  NeemWorkerPoolState,
  NeemWorkerState,
} from '../../shared/types.ts'
import type { WorkerUpdateBatch } from '../build/updates.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { HostHooks } from '../plugins/hooks.ts'
import type { WorkerPatchResult } from '../worker/protocol.ts'
import type { RecoveryOptions, RecoveryPolicy } from './recovery.ts'
import type { HostRunnerData } from './runner-protocol.ts'
import type { ThreadPlan, ThreadLifecycleEvent } from './thread.ts'
import { childLogger, runtimeLabel } from '../logger.ts'
import { callHostHook } from '../plugins/hooks.ts'
import { normalizeError, raceWithTimeout, throwCollected } from '../utils.ts'
import { createRuntimeEnv } from './env.ts'
import {
  isOperationAborted,
  OperationScope,
  resolveLifecycle,
} from './lifecycle.ts'
import { createRecoveryPolicy, getRecoveryDelay } from './recovery.ts'
import { HostRunner } from './runner.ts'
import { ThreadController } from './thread.ts'

export type RuntimePatchResult = (
  | { outcome: 'applied' }
  // `reset` marks the patch budget: the runtime restarts although nothing
  // failed, so the next bundle carries every patch.
  | { outcome: 'rejected'; reason: string; reset?: true }
  // Recovery is already replacing the threads whose generation was retired.
  | { outcome: 'unavailable'; reason: string }
) & { deliveredFiles: readonly string[] }

export type RuntimeControllerOptions = {
  onThreadEvent?: (event: ThreadLifecycleEvent) => void
  // Runs after the failed runtime is cleaned up and before it starts again.
  prepareRecovery?: () => Promise<void>
  snapshot: RuntimeSnapshot
  runtimeName: string
  hooks: HostHooks
  recovery?: RecoveryOptions
  // Reports a failure the recovery policy could not repair.
  onFailure?: (error: Error, runtime: RuntimeController) => MaybePromise<void>
  onRecovered?: (runtime: RuntimeController) => MaybePromise<void>
  // Runs when failed or cleaned-up workers stop advertising upstreams.
  onUpstreamsChange?: (runtime: RuntimeController) => MaybePromise<void>
}

// The host runner and threads of one start attempt. Events carry the id of the
// generation that produced them, so a retired generation cannot steer this one.
type Generation = {
  id: number
  host?: HostRunner
  threads: readonly ThreadController[]
  // Present while the attempt is starting: a failure reported by one of its
  // members fails the attempt instead of starting a recovery around it.
  starting?: { scope: OperationScope; failure?: Error }
}

type Operation = { scope: OperationScope; settled: Promise<void> }

/**
 * Sole owner of one runtime's lifecycle. Start, recovery and stop are
 * operations: at most one start or recovery runs at a time, and stop aborts it
 * and joins it before releasing the generation it left behind.
 */
export class RuntimeController {
  private state: NeemRuntimeState = 'idle'
  private lastError: Error | undefined
  private generations = 0
  private current: Generation | undefined
  private operation: Operation | undefined
  private stopping: Promise<void> | undefined
  private restartAttempts = 0
  private readonly logger: Logger

  constructor(private readonly options: RuntimeControllerOptions) {
    this.logger = childLogger(
      options.snapshot.logger,
      runtimeLabel(options.runtimeName),
    )
  }

  get name(): string {
    return this.options.runtimeName
  }

  getState(): NeemRuntimeState {
    return this.state
  }

  getLastError(): Error | undefined {
    return this.lastError
  }

  listThreads(): readonly ThreadController[] {
    return this.current?.threads ?? []
  }

  getUpstreams(): readonly NeemRuntimeUpstream[] {
    return this.listThreads().flatMap((thread) => thread.getUpstreams())
  }

  /**
   * Applies one DevEngine update to every thread. A thread whose generation
   * the patch retired without a replacement fails as if it had crashed, so
   * recovery restarts the runtime from the output on disk.
   */
  async applyPatch(updates: WorkerUpdateBatch): Promise<RuntimePatchResult> {
    if (this.state !== 'ready') {
      return {
        outcome: 'rejected',
        deliveredFiles: [],
        reason: `Runtime [${this.name}] is not ready`,
      }
    }
    const threadList = this.listThreads()
    const maxPatches =
      this.options.snapshot.manifest.config.build?.updates?.maxPatches ?? 50
    // The budget permits exactly maxPatches successful patches; recycle before
    // applying the following edit, so the fresh bundle includes that edit too.
    if (threadList.some((thread) => thread.patches >= maxPatches)) {
      return {
        outcome: 'rejected',
        deliveredFiles: [],
        reset: true,
        reason: `Worker patch budget reached (${maxPatches})`,
      }
    }
    // A thread that registered after DevEngine computed this update may have
    // loaded output without it, and the engine would treat it as current.
    const clients = new Set(updates.map(({ clientId }) => clientId))
    const missed = threadList.find((thread) => !clients.has(thread.id))
    if (missed) {
      return {
        outcome: 'rejected',
        deliveredFiles: [],
        reason: `Worker [${missed.name}] started without this update`,
      }
    }
    const threads = new Map(threadList.map((thread) => [thread.id, thread]))
    const results = await Promise.all(
      updates.map(async ({ clientId, update }) => {
        const thread = threads.get(clientId)
        if (!thread) {
          return {
            update,
            result: rejectedPatch(
              `Patch client [${clientId}] is no longer running`,
            ),
          }
        }

        try {
          return { update, thread, result: await thread.applyPatch(update) }
        } catch (error) {
          // A timed-out patch, a worker that exited mid-patch or one no longer
          // running: none of them shows that the generation survived.
          return {
            update,
            thread,
            result: unavailablePatch(normalizeError(error).message),
          }
        }
      }),
    )
    let rejected: string | undefined
    let unavailable: string | undefined
    const delivered = new Set<string>()
    for (const { update, thread, result } of results) {
      if (result.delivered && update.type === 'Patch')
        delivered.add(update.filename)
      if (result.outcome === 'rejected') rejected ??= result.reason
      if (result.outcome === 'unavailable') {
        unavailable ??= result.reason
        thread?.reportFailure(
          new Error(
            `Worker [${thread.name}] has no running generation after a failed patch: ${result.reason}`,
          ),
        )
      }
    }
    const deliveredFiles = Array.from(delivered)
    if (unavailable !== undefined) {
      return { outcome: 'unavailable', reason: unavailable, deliveredFiles }
    }
    if (rejected !== undefined) {
      return { outcome: 'rejected', reason: rejected, deliveredFiles }
    }
    return { outcome: 'applied', deliveredFiles }
  }

  getHealth(): NeemRuntimeServerRuntimeHealth {
    return {
      name: this.name,
      // Readiness is the lifecycle state, not the thread count: a recovering
      // runtime has no threads for a moment and still serves nothing.
      ready: this.state === 'ready',
      state: this.state,
      pool: this.getPoolHealth(),
      threads: this.listThreads().map((thread) => thread.getHealth()),
    }
  }

  /**
   * Rejects with the start failure, or with OperationAbortedError when the
   * parent scope or stop() aborts it; stop() then releases what it started.
   */
  start(parent: OperationScope = new OperationScope()): Promise<void> {
    if (this.state !== 'idle') {
      return Promise.reject(
        new Error(`Runtime [${this.name}] cannot start while ${this.state}`),
      )
    }
    this.setState('starting')
    return this.runOperation(parent, async (scope) => {
      try {
        await this.startGeneration(scope)
      } catch (error) {
        if (!isOperationAborted(error)) {
          this.setState('failed', normalizeError(error))
        }
        throw error
      }
      this.setState('ready')
    })
  }

  /**
   * Stops within the scope's deadline and rejects with every cleanup error,
   * including workers or the host runner terminated at the deadline. A stop
   * requested while one runs joins it; one after it finished is a no-op.
   */
  stop(scope: OperationScope = this.createStopScope()): Promise<void> {
    this.stopping ??= this.runStop(scope).finally(() => {
      this.stopping = Promise.resolve()
    })
    return this.stopping
  }

  private async runStop(scope: OperationScope): Promise<void> {
    this.setState('stopping')
    const errors: Error[] = []
    const operation = this.operation
    if (operation) {
      operation.scope.abort()
      const joined = await raceWithTimeout(operation.settled, scope.remaining())
      if (joined.timedOut) {
        errors.push(
          new Error(
            `Runtime [${this.name}] start or recovery did not settle before the stop deadline`,
          ),
        )
      }
    }
    await this.releaseGeneration(scope).catch((error) => {
      errors.push(normalizeError(error))
    })
    this.setState('stopped')
    throwCollected(errors, `Runtime [${this.name}] did not stop cleanly`)
  }

  private runOperation(
    parent: OperationScope,
    run: (scope: OperationScope) => Promise<void>,
  ): Promise<void> {
    const scope = parent.child()
    const promise = run(scope).finally(() => {
      scope.dispose()
      if (this.operation?.scope === scope) this.operation = undefined
    })
    this.operation = { scope, settled: promise.then(noop, noop) }
    return promise
  }

  // One start attempt: creates a generation and brings it to ready or throws.
  // A failed attempt releases its generation; an aborted one leaves it to stop().
  private async startGeneration(scope: OperationScope): Promise<void> {
    const attempt = scope.child()
    const generation: Generation = {
      id: ++this.generations,
      threads: [],
      starting: { scope: attempt },
    }
    this.current = generation
    this.logger.debug('Neem runtime starting')

    try {
      await attempt.wait(this.callRuntimeHook('runtime:start'))
      // Nothing is launched once a stop aborted the attempt: stop() may
      // already have released this generation without it.
      attempt.throwIfAborted()
      const host = this.createHostRunner(generation.id)
      generation.host = host
      await attempt.wait(host.start())
      const plan = await attempt.wait(host.plan())
      const threadPlans = resolveThreadTopology({
        snapshot: this.options.snapshot,
        runtimeName: this.name,
        plan,
      })
      this.logger.trace(
        {
          threads: threadPlans.map((thread) => ({
            name: thread.name,
            artifactId: thread.artifact.id,
          })),
        },
        'Neem runtime worker topology',
      )

      attempt.throwIfAborted()
      generation.threads = threadPlans.map(
        (plan, index) =>
          new ThreadController({
            snapshot: this.options.snapshot,
            runtimeName: this.name,
            plan,
            index,
            hooks: this.options.hooks,
            onThreadEvent: this.options.onThreadEvent,
            onFailure: (error, thread) =>
              this.handleFailure(error, generation.id, `worker ${thread.name}`),
          }),
      )

      await Promise.all(
        generation.threads.map((thread) => thread.start(attempt)),
      )
      await attempt.wait(host.callStart(this.getThreadHandles()))
      await attempt.wait(
        this.callRuntimeHook('runtime:ready', this.getUpstreams()),
      )
      this.logger.debug('Neem runtime ready')
      this.logger.trace(
        {
          threads: generation.threads.length,
          upstreams: this.getUpstreams().length,
        },
        'Neem runtime summary',
      )
    } catch (error) {
      const failure = generation.starting?.failure
      if (isOperationAborted(error) && !failure) {
        await this.releaseAbandoned(generation)
        throw error
      }
      const normalized = failure ?? normalizeError(error)
      // The outer scope, not the attempt: a stop arriving now still aborts
      // the remaining failure handling and takes over the cleanup.
      await scope.wait(this.callRuntimeFailHook(normalized))
      await this.releaseGeneration(this.createStopScope()).catch(
        (stopError) => {
          this.logger.warn(
            new Error(`Runtime [${this.name}] cleanup failed`, {
              cause: normalizeError(stopError),
            }),
          )
        },
      )
      throw normalized
    } finally {
      generation.starting = undefined
      attempt.dispose()
    }
  }

  // stop() releases the generation it finds once it has joined this attempt
  // or given up joining it. A generation that is still current after the stop
  // completed was never released, so the attempt releases it itself.
  private async releaseAbandoned(generation: Generation): Promise<void> {
    if (this.state !== 'stopped' || this.current !== generation) return
    await this.releaseGeneration(this.createStopScope()).catch((error) => {
      this.logger.warn(
        new Error(`Runtime [${this.name}] cleanup after its stop failed`, {
          cause: normalizeError(error),
        }),
      )
    })
  }

  // Releases the current generation within the scope's deadline and reports
  // every error: host stop, each thread, host runner shutdown, the stop hook.
  private async releaseGeneration(scope: OperationScope): Promise<void> {
    const generation = this.current
    if (!generation) return
    this.current = undefined
    const { host, threads } = generation
    this.logger.debug('Neem runtime stopping')
    this.logger.trace({ threads: threads.length }, 'Neem runtime stop options')

    const errors: Error[] = []
    const collect = (error: unknown) => {
      errors.push(normalizeError(error))
    }
    await host?.callStop(scope).catch(collect)
    const threadResults = await Promise.allSettled(
      threads.map((thread) => thread.stop(scope)),
    )
    for (const result of threadResults) {
      if (result.status === 'rejected') collect(result.reason)
    }
    await host?.shutdown(scope).catch(collect)
    await scope
      .within(
        this.callRuntimeHook('runtime:stop'),
        `Runtime [${this.name}] hook [runtime:stop]`,
      )
      .catch(collect)
    this.logger.debug('Neem runtime stopped')
    throwCollected(errors, `Runtime [${this.name}] did not stop cleanly`)
  }

  // Failures only report here; this controller alone decides between failing
  // the attempt that is starting, recovering, or giving up.
  private handleFailure(
    error: Error,
    generationId: number,
    source: string,
  ): Promise<void> | undefined {
    const generation = this.current
    if (generation?.id !== generationId) return
    if (generation.starting) {
      generation.starting.failure ??= error
      generation.starting.scope.abort()
      return
    }
    if (this.state !== 'ready') return

    this.logger.warn({ err: error }, `Neem runtime ${source} failed`)
    const policy = createRecoveryPolicy(
      this.options.snapshot.mode,
      this.options.recovery,
    )
    this.setState(policy.attempts === 0 ? 'failed' : 'recovering', error)
    const recovery = this.runOperation(new OperationScope(), (scope) =>
      this.recover(error, policy, scope),
    )
    // A stop aborts recovery and joins it; that outcome belongs to the stop.
    return recovery.catch((recoveryError) => {
      if (isOperationAborted(recoveryError)) return
      this.logger.error(
        { err: normalizeError(recoveryError) },
        'Neem runtime recovery failed',
      )
    })
  }

  private async recover(
    initialError: Error,
    policy: RecoveryPolicy,
    scope: OperationScope,
  ): Promise<void> {
    // Detach before hooks and the recovery delay so routing stops reaching the dead worker.
    await this.options.onUpstreamsChange?.(this)
    await scope.wait(this.callRuntimeFailHook(initialError))
    if (policy.attempts === 0) {
      await this.options.onFailure?.(initialError, this)
      return
    }

    let lastError = initialError
    while (this.restartAttempts < policy.attempts) {
      const attempt = this.restartAttempts + 1
      this.restartAttempts = attempt
      this.logger.warn(
        { err: lastError },
        `Restarting Neem runtime after failure (${attempt}/${policy.attempts})`,
      )
      await scope.sleep(getRecoveryDelay(policy, attempt))

      try {
        await this.releaseGeneration(this.createStopScope())
        scope.throwIfAborted()
        await this.options.onUpstreamsChange?.(this)
        scope.throwIfAborted()
        await scope.wait(this.options.prepareRecovery?.())
        await this.startGeneration(scope)
        this.restartAttempts = 0
        this.setState('ready')
        await this.options.onRecovered?.(this)
        return
      } catch (error) {
        if (isOperationAborted(error)) throw error
        lastError = normalizeError(error)
      }
    }

    this.logger.error({ err: lastError }, 'Neem runtime recovery exhausted')
    this.setState('failed', lastError)
    await this.options.onFailure?.(lastError, this)
  }

  // Stopping and stopped belong to stop(): an operation settling after the
  // stop began must not move the runtime back to another state.
  private setState(state: NeemRuntimeState, error?: Error): void {
    if (this.state === 'stopped') return
    if (this.state === 'stopping' && state !== 'stopped') return
    this.state = state
    this.lastError = error
    this.logger.trace({ state, err: error }, 'Neem runtime state')
  }

  private createStopScope(): OperationScope {
    const { stopTimeout } = resolveLifecycle(
      this.options.snapshot.config.lifecycle,
    )
    return OperationScope.withTimeout(stopTimeout)
  }

  private createHostRunner(generationId: number): HostRunner {
    return new HostRunner({
      entry: this.options.snapshot.runnerEntry,
      data: this.createHostRunnerData(),
      env: this.createRuntimeEnv(),
      onFailure: (error) => this.handleFailure(error, generationId, 'host'),
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

  private async callRuntimeFailHook(error: Error): Promise<void> {
    await this.callRuntimeHook('runtime:fail', undefined, error).catch(
      (hookError) => {
        this.logger.warn(
          new Error(`Runtime [${this.name}] fail hook failed`, {
            cause: normalizeError(hookError),
          }),
        )
      },
    )
  }

  private callRuntimeHook(
    name: 'runtime:start' | 'runtime:ready' | 'runtime:stop' | 'runtime:fail',
    upstreams?: readonly NeemRuntimeUpstream[],
    error?: Error,
  ): Promise<void> {
    this.logger.trace(
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
    const threads = this.listThreads()
    const counts: Record<NeemWorkerState, number> = {
      idle: 0,
      starting: 0,
      ready: 0,
      stopping: 0,
      stopped: 0,
      failed: 0,
    }
    for (const thread of threads) counts[thread.getState()]++

    const size = threads.length
    const state = getPoolState(counts, size)
    return {
      name: `runtime:${this.name}`,
      state,
      size,
      ready: counts.ready,
      failed: counts.failed,
      stopped: counts.stopped,
      starting: counts.starting,
    }
  }

  private getThreadHandles() {
    return this.listThreads().map((thread) => thread.getHandle())
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

  if (plans.length === 0) return []
  if (!workerArtifact) {
    throw new Error(
      `Runtime [${options.runtimeName}] planned workers but has no worker artifact`,
    )
  }

  return plans.map((plan) => ({
    name: plan.name,
    artifact: workerArtifact,
    data: plan.data,
  }))
}

function normalizePlannedWorkers(
  runtimeName: string,
  workers: unknown,
): readonly { name: string; data: unknown }[] {
  if (Array.isArray(workers)) {
    return workers.map((data, index) => {
      const name = `${runtimeName}:${index}`
      return { name, data: cloneWorkerData(runtimeName, name, data) }
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
      return { name, data: cloneWorkerData(runtimeName, name, data) }
    }),
  )
}

function isGroupedWorkerPlan(
  workers: unknown,
): workers is Record<string, readonly unknown[]> {
  if (typeof workers !== 'object' || workers === null) return false
  return Object.values(workers).every((group) => Array.isArray(group))
}

// Cloning here both validates the planner data and detaches it from the
// planner's object graph before it crosses the thread boundary.
function cloneWorkerData(
  runtimeName: string,
  workerName: string,
  data: unknown,
): unknown {
  try {
    return structuredClone(data)
  } catch (error) {
    throw new Error(
      `Runtime [${runtimeName}] worker [${workerName}] data must be structured-cloneable`,
      { cause: normalizeError(error) },
    )
  }
}

function getPoolState(
  counts: Record<NeemWorkerState, number>,
  size: number,
): NeemWorkerPoolState {
  if (size === 0) return 'ready'
  if (counts.idle === size) return 'idle'
  if (counts.starting > 0) return 'starting'
  if (counts.stopping > 0) return 'stopping'
  if (counts.stopped === size) return 'stopped'
  if (counts.ready === size) return 'ready'
  if (counts.ready > 0) return 'degraded'
  if (counts.failed > 0) return 'failed'
  return 'idle'
}

function rejectedPatch(reason: string): WorkerPatchResult {
  return { outcome: 'rejected', delivered: false, patches: 0, reason }
}

function unavailablePatch(reason: string): WorkerPatchResult {
  return { outcome: 'unavailable', delivered: false, patches: 0, reason }
}

function noop(): void {}
