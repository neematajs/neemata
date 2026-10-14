import type { Logger } from 'pino'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Scope from 'effect/Scope'

import type {
  NeemRuntimeServerRuntimeHealth,
  NeemRuntimeState,
  NeemRuntimeUpstream,
  NeemWorkerPoolHealth,
  NeemWorkerPoolState,
  NeemWorkerState,
} from '../shared/types.ts'
import type { WorkerUpdateBatch } from './build/updates.ts'
import type { HostContext } from './context.ts'
import type { RecoveryOptions, RecoveryPolicy } from './host/recovery.ts'
import type { Deadline } from './lifetime.ts'
import type { RuntimeSnapshot } from './manifest/snapshot.ts'
import type { WorkerPatchResult } from './protocol.ts'
import { callHook, lifecycleOf } from './context.ts'
import { createRuntimeEnv } from './host/env.ts'
import { createRecoveryPolicy } from './host/recovery.ts'
import {
  resolveRequiredRuntimeArtifact,
  resolveThreadTopology,
} from './host/topology.ts'
import {
  attempt,
  Deadline as DeadlineClass,
  Lifetime,
  releaseStep,
  within,
} from './lifetime.ts'
import { childLogger, runtimeLabel } from './logger.ts'
import { HostRunner } from './runner.ts'
import { callbackRunner } from './tasks.ts'
import { Thread } from './thread.ts'

export type RuntimeSupervisorOptions = {
  context: HostContext
  snapshot: RuntimeSnapshot
  runtimeName: string
  recovery?: RecoveryOptions
  // Runs after the failed generation is released and before the next starts.
  prepareRecovery?: () => Promise<void>
  /** A failure recovery could not repair. */
  onFailure: (error: Error) => void
  onRecovered: () => void
  // Failed or released threads stopped advertising upstreams.
  onUpstreamsChange: () => Effect.Effect<void>
  // Runtime state feeds the host's readiness.
  onStateChange: () => void
}

type PatchOutcome = {
  update: WorkerUpdateBatch[number]['update']
  thread: Thread | undefined
  result: WorkerPatchResult
}

/**
 * One start attempt: the host runner and the threads it planned, all owned by
 * one lifetime. Members report failures to `failure`; only the attempt that is
 * still current listens, so a released generation cannot steer its successor.
 */
type Generation = {
  readonly lifetime: Lifetime
  readonly failure: Deferred.Deferred<never, Error>
  threads: readonly Thread[]
}

/**
 * Sole owner of one runtime. A start or a recovery is the runtime's one
 * operation at a time; `stop` interrupts it, joins it and closes everything
 * the runtime still owns, within one deadline.
 */
export class RuntimeSupervisor {
  readonly name: string
  private readonly options: RuntimeSupervisorOptions
  private readonly logger: Logger
  private readonly lifetime: Lifetime
  private state: NeemRuntimeState = 'idle'
  private lastError: Error | undefined
  private current: Generation | undefined
  private recovery: Fiber.Fiber<void> | undefined
  private stopping: Fiber.Fiber<readonly Error[]> | undefined
  private runRecovery:
    | ((effect: Effect.Effect<void>) => Fiber.Fiber<void>)
    | undefined

  constructor(options: RuntimeSupervisorOptions) {
    this.options = options
    this.name = options.runtimeName
    this.logger = childLogger(options.snapshot.logger, runtimeLabel(this.name))
    this.lifetime = Lifetime.make(lifecycleOf(options.snapshot).stopTimeout)
  }

  getState(): NeemRuntimeState {
    return this.state
  }

  getLastError(): Error | undefined {
    return this.lastError
  }

  listThreads(): readonly Thread[] {
    return this.current?.threads ?? []
  }

  getUpstreams(): readonly NeemRuntimeUpstream[] {
    return this.listThreads().flatMap((thread) => thread.getUpstreams())
  }

  getHealth(): NeemRuntimeServerRuntimeHealth {
    return {
      name: this.name,
      // A recovering runtime has no threads for a moment and still serves nothing.
      ready: this.state === 'ready',
      state: this.state,
      pool: this.getPoolHealth(),
      threads: this.listThreads().map((thread) => thread.getHealth()),
    }
  }

  /** Brings the first generation up; an interrupted start leaves it to `stop`. */
  start(): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      if (this.state !== 'idle') {
        return Effect.fail(
          new Error(`Runtime [${this.name}] cannot start while ${this.state}`),
        )
      }
      this.setState('starting')
      return Effect.gen({ self: this }, function* () {
        this.lifetime.clock = yield* Clock.Clock
        this.runRecovery = yield* callbackRunner(this.lifetime)
        yield* this.startGeneration()
      }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => this.setState('failed', error)),
        ),
        Effect.tap(() => Effect.sync(() => this.setState('ready'))),
      )
    })
  }

  /**
   * Stops within the deadline and resolves with every cleanup error. A stop
   * requested while one runs joins it and shares its deadline.
   */
  stop(deadline: Deadline): Effect.Effect<readonly Error[]> {
    // Every step of the stop bounds itself by the first deadline, so joining
    // it needs no bound of its own.
    return Effect.gen({ self: this }, function* () {
      this.stopping ??= yield* Effect.forkDetach(this.runStop(deadline))
      return yield* Fiber.join(this.stopping)
    })
  }

  /**
   * Applies one DevEngine update to every thread. A thread whose generation the
   * patch retired without a replacement fails as if it had crashed, so
   * recovery restarts the runtime from the output on disk.
   */
  applyPatch(updates: WorkerUpdateBatch): Effect.Effect<RuntimePatchResult> {
    return Effect.suspend(() => {
      if (this.state !== 'ready') {
        return Effect.succeed(rejected(`Runtime [${this.name}] is not ready`))
      }
      const threads = this.listThreads()
      const maxPatches =
        this.options.snapshot.manifest.config.build?.updates?.maxPatches ?? 50
      // The budget allows exactly maxPatches patches; the restart before the
      // next one rebuilds with that edit included.
      if (threads.some((thread) => thread.patches >= maxPatches)) {
        return Effect.succeed({
          ...rejected(`Worker patch budget reached (${maxPatches})`),
          reset: true as const,
        })
      }
      // A thread registered after DevEngine computed this update may have
      // loaded output without it.
      const clients = new Set(updates.map(({ clientId }) => clientId))
      const missed = threads.find((thread) => !clients.has(thread.id))
      if (missed) {
        return Effect.succeed(
          rejected(`Worker [${missed.name}] started without this update`),
        )
      }
      const byId = new Map(threads.map((thread) => [thread.id, thread]))
      return Effect.forEach(
        updates,
        ({ clientId, update }): Effect.Effect<PatchOutcome> => {
          const thread = byId.get(clientId)
          if (!thread) {
            return Effect.succeed({
              update,
              thread,
              result: patchResult(
                'rejected',
                `Patch client [${clientId}] is no longer running`,
              ),
            })
          }
          return thread.applyPatch(update).pipe(
            // A timed-out patch or a worker gone mid-patch: neither shows
            // that the generation survived.
            Effect.catch((error) =>
              Effect.succeed(patchResult('unavailable', error.message)),
            ),
            Effect.map((result) => ({ update, thread, result })),
          )
        },
        { concurrency: 'unbounded' },
      ).pipe(Effect.map((results) => this.summarizePatch(results)))
    })
  }

  private summarizePatch(results: readonly PatchOutcome[]): RuntimePatchResult {
    let rejectedReason: string | undefined
    let unavailable: string | undefined
    const delivered = new Set<string>()
    for (const { update, thread, result } of results) {
      if (result.delivered && update.type === 'Patch')
        delivered.add(update.filename)
      if (result.outcome === 'rejected') rejectedReason ??= result.reason
      if (result.outcome === 'unavailable') {
        unavailable ??= result.reason
        thread?.reportFailure(
          new Error(
            `Worker [${thread.name}] has no running generation after a failed patch: ${result.reason}`,
          ),
        )
      }
    }
    const deliveredFiles = [...delivered]
    if (unavailable !== undefined) {
      return { outcome: 'unavailable', reason: unavailable, deliveredFiles }
    }
    if (rejectedReason !== undefined) {
      return { outcome: 'rejected', reason: rejectedReason, deliveredFiles }
    }
    return { outcome: 'applied', deliveredFiles }
  }

  private runStop(deadline: Deadline): Effect.Effect<readonly Error[]> {
    return Effect.gen({ self: this }, function* () {
      this.setState('stopping')
      const errors: Error[] = []
      const recovery = this.recovery
      if (recovery) {
        recovery.interruptUnsafe()
        // A recovery releasing a generation finishes that release first.
        const joined = yield* within(Fiber.await(recovery), deadline)
        if (Option.isNone(joined)) {
          errors.push(
            new Error(
              `Runtime [${this.name}] recovery did not settle before the stop deadline`,
            ),
          )
        }
      }
      errors.push(...(yield* this.lifetime.close(deadline)))
      this.current = undefined
      this.setState('stopped')
      return errors
    })
  }

  // One start attempt: a generation brought to ready, or released and failed.
  // An interrupted attempt leaves its generation to whoever interrupted it.
  private startGeneration(): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const lifetime = this.lifetime.fork()
      const generation: Generation = {
        lifetime,
        failure: Deferred.makeUnsafe(),
        threads: [],
      }
      this.current = generation
      this.logger.debug('Neem runtime starting')

      // Registered first, so it runs last, after the threads and runner.
      yield* Scope.addFinalizer(
        lifetime.scope,
        Effect.suspend(() => {
          this.logger.debug('Neem runtime stopping')
          return releaseStep(
            `Runtime [${this.name}] hook [runtime:stop]`,
            this.hook('runtime:stop'),
            lifetime.deadline(),
          )
        }),
      )

      const bringUp = Effect.gen({ self: this }, function* () {
        yield* this.hook('runtime:start')
        const runner = yield* HostRunner.start(lifetime, {
          snapshot: this.options.snapshot,
          data: this.runnerData(),
          env: this.runtimeEnv(),
          registry: this.options.context.registry,
          onFailure: (error) => this.report(generation, error, 'host'),
        })
        const plan = yield* runner.plan()
        const plans = yield* Effect.try({
          try: () =>
            resolveThreadTopology({
              snapshot: this.options.snapshot,
              runtimeName: this.name,
              plan,
            }),
          catch: (error) => error as Error,
        })
        this.logger.trace(
          {
            threads: plans.map((plan) => ({
              name: plan.name,
              artifactId: plan.artifact.id,
            })),
          },
          'Neem runtime worker topology',
        )
        const threadsLifetime = lifetime.fork('parallel')
        generation.threads = plans.map(
          (plan, index) =>
            new Thread({
              context: this.options.context,
              snapshot: this.options.snapshot,
              runtimeName: this.name,
              plan,
              index,
              onFailure: (error, thread) =>
                this.report(generation, error, `worker ${thread.name}`),
            }),
        )
        yield* Effect.forEach(
          generation.threads,
          (thread) => thread.start(threadsLifetime.fork()),
          { concurrency: 'unbounded', discard: true },
        )
        // Registered after the threads, so the user's host stops before them.
        yield* Scope.addFinalizer(
          lifetime.scope,
          Effect.suspend(() =>
            releaseStep(
              `Runtime [${this.name}] host stop`,
              runner.stopHost(lifetime.deadline()),
              lifetime.deadline(),
            ),
          ),
        )
        yield* runner.start(
          generation.threads.map((thread) => thread.getHandle()),
        )
        yield* this.hook('runtime:ready', this.getUpstreams())
      })

      // A member failing while the attempt starts fails the attempt.
      const started = yield* Effect.raceFirst(
        bringUp,
        Deferred.await(generation.failure),
      ).pipe(Effect.exit)

      if (started._tag === 'Success') {
        yield* Deferred.await(generation.failure).pipe(
          Effect.flatMap(() => Effect.void),
          Effect.catch((error) =>
            Effect.sync(() => this.onFailure(generation, error)),
          ),
          Effect.forkIn(lifetime.scope),
        )
        this.logger.debug('Neem runtime ready')
        return
      }
      if (Cause.hasInterruptsOnly(started.cause)) {
        return yield* Effect.interrupt
      }
      const error = Cause.squash(started.cause) as Error
      yield* this.failHook(error)
      if (this.current === generation) this.current = undefined
      const cleanup = yield* lifetime.close(
        DeadlineClass.after(
          lifecycleOf(this.options.snapshot).stopTimeout,
          this.lifetime.clock,
        ),
      )
      for (const cleanupError of cleanup) {
        this.logger.warn(
          new Error(`Runtime [${this.name}] cleanup failed`, {
            cause: cleanupError,
          }),
        )
      }
      return yield* Effect.fail(error)
    })
  }

  private report(generation: Generation, error: Error, source: string): void {
    if (this.current !== generation) return
    this.logger.warn({ err: error }, `Neem runtime ${source} failed`)
    Deferred.doneUnsafe(generation.failure, Effect.fail(error))
  }

  // Only a ready runtime recovers; any other state already has an owner.
  private onFailure(generation: Generation, error: Error): void {
    if (this.current !== generation || this.state !== 'ready') return
    const policy = createRecoveryPolicy(
      this.options.snapshot.mode,
      this.options.recovery,
    )
    this.setState(policy.attempts === 0 ? 'failed' : 'recovering', error)
    this.recovery = this.runRecovery!(
      this.recover(error, policy).pipe(
        Effect.withSpan('neem.runtime.recovery', {
          attributes: { runtime: this.name },
        }),
        // A defect must not leave the runtime recovering forever.
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            if (Cause.hasInterruptsOnly(cause)) return
            const failure = Cause.squash(cause) as Error
            this.logger.error({ err: failure }, 'Neem runtime recovery failed')
            this.setState('failed', failure)
            this.options.onFailure(failure)
          }),
        ),
      ),
    )
  }

  private recover(
    initialError: Error,
    policy: RecoveryPolicy,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      // Detached before hooks and delays, so routing stops reaching the dead worker.
      yield* this.options.onUpstreamsChange()
      yield* this.failHook(initialError)
      if (policy.attempts === 0) {
        this.options.onFailure(initialError)
        return
      }

      let attemptNumber = 0
      let lastError = initialError
      const next = yield* Schedule.toStepWithSleep(
        Schedule.exponential(policy.delayMs, policy.factor).pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(
              Math.min(Duration.toMillis(duration), policy.maxDelayMs),
            ),
          ),
        ),
      )
      const restart = Effect.gen({ self: this }, function* () {
        attemptNumber++
        this.logger.warn(
          { err: lastError },
          `Restarting Neem runtime after failure (${attemptNumber}/${policy.attempts})`,
        )
        yield* next(lastError).pipe(Effect.orDie)
        yield* this.releaseCurrent()
        yield* this.options.onUpstreamsChange()
        if (this.options.prepareRecovery)
          yield* attempt(this.options.prepareRecovery)
        yield* this.startGeneration()
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
          lastError = Cause.squash(cause) as Error
          return Effect.fail(lastError)
        }),
      )
      // The first restart also waits; retry counts are additional attempts.
      const started = yield* Effect.exit(
        restart.pipe(Effect.retry(Schedule.recurs(policy.attempts - 1))),
      )
      if (started._tag === 'Success') {
        this.setState('ready')
        this.options.onRecovered()
        return
      }
      if (Cause.hasInterruptsOnly(started.cause)) return yield* Effect.interrupt
      this.logger.error({ err: lastError }, 'Neem runtime recovery exhausted')
      this.setState('failed', lastError)
      this.options.onFailure(lastError)
    })
  }

  // A replaced generation is gone either way: what missed the deadline was
  // terminated. Its replacement still starts.
  private releaseCurrent(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const generation = this.current
      if (!generation) return Effect.void
      this.current = undefined
      return generation.lifetime
        .close(
          DeadlineClass.after(
            lifecycleOf(this.options.snapshot).stopTimeout,
            this.lifetime.clock,
          ),
        )
        .pipe(
          Effect.flatMap((errors) =>
            Effect.sync(() => {
              for (const error of errors) {
                this.logger.error(
                  { err: error },
                  'Neem runtime did not stop cleanly before its replacement',
                )
              }
            }),
          ),
        )
    })
  }

  // Stopping and stopped belong to stop: an operation settling after the stop
  // began must not move the runtime to another state.
  private setState(state: NeemRuntimeState, error?: Error): void {
    if (this.state === 'stopped') return
    if (this.state === 'stopping' && state !== 'stopped') return
    this.state = state
    this.lastError = error
    this.logger.trace({ state, err: error }, 'Neem runtime state')
    this.options.onStateChange()
  }

  private runtimeEnv(): NodeJS.ProcessEnv {
    return createRuntimeEnv({
      manifest: this.options.snapshot.manifest,
      runtimeName: this.name,
      overrideEnv: this.options.snapshot.env,
    })
  }

  private runnerData() {
    const { snapshot } = this.options
    return {
      mode: snapshot.mode,
      runtimeName: this.name,
      logger: snapshot.manifest.config.logger,
      outDir: snapshot.outDir,
      hostArtifact: resolveRequiredRuntimeArtifact(snapshot, this.name, 'host'),
      plannerArtifact: resolveRequiredRuntimeArtifact(
        snapshot,
        this.name,
        'planner',
      ),
    }
  }

  private hook(
    name: 'runtime:start' | 'runtime:ready' | 'runtime:stop' | 'runtime:fail',
    upstreams?: readonly NeemRuntimeUpstream[],
    error?: Error,
  ): Effect.Effect<void, Error> {
    const { context, snapshot } = this.options
    return callHook(context.hooks, snapshot.logger, name, {
      mode: snapshot.mode,
      name: this.name,
      upstreams,
      error,
    })
  }

  private failHook(error: Error): Effect.Effect<void> {
    return this.hook('runtime:fail', undefined, error).pipe(
      Effect.catch((hookError) =>
        Effect.sync(() =>
          this.logger.warn(
            new Error(`Runtime [${this.name}] fail hook failed`, {
              cause: hookError,
            }),
          ),
        ),
      ),
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
    return {
      name: `runtime:${this.name}`,
      state: poolState(counts, size),
      size,
      ready: counts.ready,
      failed: counts.failed,
      stopped: counts.stopped,
      starting: counts.starting,
    }
  }
}

function poolState(
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

function rejected(reason: string): RuntimePatchResult {
  return { outcome: 'rejected', deliveredFiles: [], reason }
}

function patchResult(
  outcome: 'rejected' | 'unavailable',
  reason: string,
): WorkerPatchResult {
  return { outcome, delivered: false, patches: 0, reason }
}

export type RuntimePatchResult = (
  | { outcome: 'applied' }
  // `reset` marks the patch budget: the runtime restarts although nothing
  // failed, so the next bundle carries every patch.
  | { outcome: 'rejected'; reason: string; reset?: true }
  // Recovery is already replacing the threads whose generation was retired.
  | { outcome: 'unavailable'; reason: string }
) & { deliveredFiles: readonly string[] }
