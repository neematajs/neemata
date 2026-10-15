import type { Logger } from 'pino'
import * as Cause from 'effect/Cause'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as FiberSet from 'effect/FiberSet'
import * as Option from 'effect/Option'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import type {
  NeemProxyHealth,
  NeemRuntimeServerHealth,
  NeemRuntimeServerSnapshot,
  NeemRuntimeServerState,
  NeemRuntimeUpstream,
} from '../shared/types.ts'
import type { WorkerUpdateBatch } from './build/updates.ts'
import type { HostContext, ThreadLifecycleEvent } from './context.ts'
import type { RecoveryOptions } from './host/recovery.ts'
import type { RuntimeSnapshot } from './manifest/snapshot.ts'
import type { RuntimePatchResult } from './runtime.ts'
import { callHook, lifecycleOf } from './context.ts'
import { createHostHooks, type HostHooks } from './hooks.ts'
import { evaluateHealth } from './host/health.ts'
import {
  closeWithin,
  Deadline,
  Lifetime,
  releaseStep,
  within,
} from './lifetime.ts'
import { childLogger } from './logger.ts'
import { acquirePlugins } from './plugins.ts'
import { ProxyController } from './proxy.ts'
import { RuntimeSupervisor } from './runtime.ts'
import { callbackRunner } from './tasks.ts'
import { WorkerRegistry } from './transport.ts'
import { throwCollected } from './utils.ts'

export type HostOptions = {
  snapshot: RuntimeSnapshot
  hooks?: HostHooks
  /** Defaults to production: a runtime failure recovery cannot repair fails the server. */
  failOnWorkerError?: boolean
  recovery?: RecoveryOptions
  onThreadEvent?: (event: ThreadLifecycleEvent) => void
  prepareRecovery?: (runtimeName: string) => Promise<void>
  onFailure?: (error: Error, runtimeName: string) => void
  onRuntimeRecovered?: (runtimeName: string) => void
}

/** The subsystems one start or reload brought up, released together. */
type Subsystems = {
  readonly lifetime: Lifetime
  proxy?: ProxyController
  readonly runtimes: Map<string, RuntimeSupervisor>
  runBackground?: (effect: Effect.Effect<void>) => Fiber.Fiber<void>
}

/**
 * The server. Start, reload, runtime reload and patch run one at a time;
 * `stop` never queues behind them: it interrupts whatever runs or waits,
 * joins it within the stop deadline, then closes everything that exists,
 * including subsystems an abandoned operation acquires later.
 */
export class Host {
  private readonly options: HostOptions
  private readonly hooks: HostHooks
  private readonly context: HostContext
  private readonly registry = new WorkerRegistry()
  private readonly permit = Semaphore.makeUnsafe(1)
  private operations: FiberSet.FiberSet | undefined
  private operationsScope = Scope.makeUnsafe()
  private clock = Effect.runSync(Clock.Clock)
  private snapshot: RuntimeSnapshot
  private logger: Logger
  private state: NeemRuntimeServerState = 'idle'
  private revision = 0
  private lastError: Error | undefined
  private subsystems: Subsystems | undefined
  private stopping: Fiber.Fiber<readonly Error[]> | undefined

  constructor(options: HostOptions) {
    this.options = options
    this.snapshot = options.snapshot
    this.logger = childLogger(options.snapshot.logger, 'neem:server')
    this.hooks = options.hooks ?? createHostHooks()
    this.context = {
      hooks: this.hooks,
      registry: this.registry,
      onThreadEvent: options.onThreadEvent,
    }
  }

  getSnapshot(): NeemRuntimeServerSnapshot {
    return {
      mode: this.snapshot.mode,
      outDir: this.snapshot.outDir,
      runtimeNames: Object.keys(this.snapshot.manifest.runtimes),
      artifactCount: this.snapshot.artifacts.list().length,
      state: this.state,
      revision: this.revision,
      lastError: this.lastError,
    }
  }

  getHealth(): NeemRuntimeServerHealth {
    const runtimes = this.runtimeList().map((runtime) => runtime.getHealth())
    const proxy = this.subsystems?.proxy?.getHealth() ?? disabledProxyHealth
    return {
      ...this.getSnapshot(),
      ready:
        this.state === 'running' &&
        runtimes.every((runtime) => runtime.ready) &&
        proxy.ready,
      runtimes,
      proxy,
    }
  }

  getUpstreams(): readonly NeemRuntimeUpstream[] {
    return this.runtimeList().flatMap((runtime) => runtime.getUpstreams())
  }

  /** Interrupted when a stop arrives first. */
  start(): Effect.Effect<void, Error> {
    return this.operation(
      Effect.suspend(() => {
        if (this.state === 'running') return Effect.void
        this.markState('starting')
        this.logger.info('Neem server starting')
        this.logger.trace(
          {
            mode: this.snapshot.mode,
            runtimes: Object.keys(this.snapshot.manifest.runtimes),
            outDir: this.snapshot.outDir,
            config: this.snapshot.manifest.config,
          },
          'Neem server options',
        )
        return this.bringUp('server:ready', 'Failed to start Neem server').pipe(
          Effect.tap(() =>
            Effect.sync(() => this.logger.info('Neem server ready')),
          ),
        )
      }),
    )
  }

  /** Replaces every subsystem with ones built from `snapshot`. */
  reload(snapshot: RuntimeSnapshot): Effect.Effect<void, Error> {
    return this.operation(
      Effect.gen({ self: this }, function* () {
        this.markState('reloading')
        this.logger.debug('Neem server reloading')
        yield* this.releaseSubsystems()
        this.replaceSnapshot(snapshot)
        yield* this.bringUp('server:reload', 'Failed to reload Neem server')
        this.logger.debug('Neem server reloaded')
      }),
    )
  }

  /**
   * Replaces one runtime. A failure leaves the server failed and is reported
   * through hooks and logs rather than returned: the other runtimes serve on.
   */
  reloadRuntime(
    runtimeName: string,
    snapshot: RuntimeSnapshot,
  ): Effect.Effect<void> {
    return this.operation(
      Effect.gen({ self: this }, function* () {
        const startedAt = yield* Clock.monotonicTimeNanos
        const subsystems = this.subsystems
        const current = subsystems?.runtimes.get(runtimeName)
        this.markState('reloading')
        this.logger.debug(`Neem runtime ${runtimeName} reloading`)
        let next: RuntimeSupervisor | undefined
        const reload = Effect.gen({ self: this }, function* () {
          if (!subsystems) {
            return yield* Effect.fail(new Error('Neem server is not running'))
          }
          if (current) {
            subsystems.runtimes.delete(runtimeName)
            // Detached from the server, nothing else would stop it, so this
            // finishes even when a stop interrupts the reload.
            yield* Effect.uninterruptible(
              this.syncProxy().pipe(
                Effect.andThen(this.stopRuntime(current, this.freshDeadline())),
              ),
            )
          }
          this.replaceSnapshot(snapshot)
          if (snapshot.manifest.runtimes[runtimeName]) {
            next = this.createRuntime(runtimeName)
            // Published before it starts, so a stop reaches it.
            subsystems.runtimes.set(runtimeName, next)
            yield* next.start()
          }
          yield* this.syncProxy()
          this.markSettled()
          yield* callHook(this.hooks, this.snapshot.logger, 'runtime:reload', {
            mode: this.snapshot.mode,
            name: runtimeName,
            upstreams:
              subsystems.runtimes.get(runtimeName)?.getUpstreams() ?? [],
          })
          this.logger.debug(
            {
              runtimeName,
              totalMs: Math.round(
                Number((yield* Clock.monotonicTimeNanos) - startedAt) / 1e6,
              ),
            },
            `Neem runtime ${runtimeName} reloaded`,
          )
        })
        yield* reload.pipe(
          Effect.catch((error) =>
            Effect.gen({ self: this }, function* () {
              if (next && subsystems?.runtimes.get(runtimeName) === next) {
                subsystems.runtimes.delete(runtimeName)
              }
              if (next) yield* this.stopRuntime(next, this.freshDeadline())
              yield* this.syncProxy()
              this.markState('failed', error)
              this.logger.error(
                { err: error, runtimeName },
                `Failed to reload Neem runtime ${runtimeName}`,
              )
              yield* this.failHook(error)
            }),
          ),
        )
      }),
    )
  }

  applyPatch(
    runtimeName: string,
    updates: WorkerUpdateBatch,
  ): Effect.Effect<RuntimePatchResult> {
    return this.operation(
      Effect.suspend(() => {
        const runtime = this.subsystems?.runtimes.get(runtimeName)
        if (!runtime) {
          return Effect.succeed<RuntimePatchResult>({
            outcome: 'rejected',
            deliveredFiles: [],
            reason: `Runtime [${runtimeName}] is not running`,
          })
        }
        return runtime.applyPatch(updates)
      }),
    )
  }

  /**
   * Interrupts the operation in flight, joins it and stops every subsystem by
   * `deadline`. Fails with every cleanup error, including workers terminated
   * at the deadline. A stop requested while one runs joins it.
   */
  stop(deadline: Deadline): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      if (!this.stopping && this.state === 'stopped') return
      const stopping = (this.stopping ??= yield* Effect.forkDetach(
        this.runStop(deadline),
      ))
      return yield* Fiber.join(stopping).pipe(
        Effect.flatMap((errors) =>
          Effect.try({
            try: () =>
              throwCollected(errors, 'Neem server did not stop cleanly'),
            catch: (error) => error as Error,
          }),
        ),
      )
    })
  }

  private runStop(deadline: Deadline): Effect.Effect<readonly Error[]> {
    return Effect.gen({ self: this }, function* () {
      // Published before the interrupts: an interrupted operation can settle
      // runtime state on its way out, e.g. a patch that no longer counts as in
      // flight, and must not report the server ready again.
      this.markState('stopping')
      this.logger.info('Neem server stopping')
      const errors: Error[] = []
      const operations = [...(this.operations ?? [])]
      for (const fiber of operations) fiber.interruptUnsafe()
      const joined = yield* within(Fiber.awaitAll(operations), deadline)
      if (Option.isNone(joined)) {
        errors.push(
          new Error(
            'Neem server operation did not settle before the stop deadline',
          ),
        )
      }

      errors.push(
        ...(yield* closeWithin(
          'Host operations',
          this.operationsScope,
          deadline,
        )),
      )
      this.operations = undefined
      this.operationsScope = Scope.makeUnsafe()
      const hook = yield* Effect.exit(
        releaseStep(
          'Neem hook [server:stop]',
          callHook(this.hooks, this.logger, 'server:stop', {
            mode: this.snapshot.mode,
          }),
          deadline,
        ),
      )
      if (hook._tag === 'Failure')
        errors.push(Cause.squash(hook.cause) as Error)
      errors.push(...(yield* this.closeSubsystems(deadline)))
      // Whatever still runs missed the deadline somewhere a release could not
      // reach, e.g. a worker an abandoned operation is still starting.
      if (this.registry.size > 0) {
        const count = this.registry.size
        yield* Effect.promise(() => this.registry.terminateAll())
        errors.push(
          new Error(
            `${count} Neem worker(s) still ran after the stop and were terminated`,
          ),
        )
      }
      this.markState('stopped')
      this.logger.debug('Neem server stopped')
      return errors
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.stopping = undefined
        }),
      ),
    )
  }

  /**
   * Runs `effect` as an operation of this server: one at a time, interrupted
   * by a stop. An operation requested during a stop is interrupted at once.
   */
  private operation<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> {
    return Effect.gen({ self: this }, function* () {
      if (this.stopping) return yield* Effect.interrupt
      this.clock = yield* Clock.Clock
      const tasks = (this.operations ??= yield* FiberSet.make().pipe(
        Scope.provide(this.operationsScope),
      ))
      const fiber = yield* FiberSet.run(
        tasks,
        this.permit.withPermit(
          effect.pipe(Effect.withSpan('neem.host.operation')),
        ),
      )
      return yield* Fiber.join(fiber).pipe(
        Effect.onInterrupt(() => Effect.sync(() => fiber.interruptUnsafe())),
      )
    })
  }

  // Start and reload share the bring-up: subsystems acquired into one
  // lifetime, published before anything is acquired so a stop reaches all of
  // it, including what an interrupted bring-up acquires after the stop.
  private bringUp(
    readyHook: 'server:ready' | 'server:reload',
    failMessage: string,
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const subsystems: Subsystems = {
        lifetime: Lifetime.make(lifecycleOf(this.snapshot).stopTimeout),
        runtimes: new Map(),
      }
      this.subsystems = subsystems
      const { lifetime } = subsystems
      lifetime.clock = this.clock
      const snapshot = this.snapshot

      yield* acquirePlugins(snapshot, this.hooks, lifetime, () =>
        this.getHealth(),
      )

      // Listening before runtimes start lets probes see a 503 from /ready
      // instead of a refused connection.
      subsystems.proxy = yield* Effect.acquireRelease(
        Effect.suspend(() => {
          const proxy = new ProxyController(snapshot, {
            getHealthStatus: () => evaluateHealth(this.getHealth()),
          })
          return proxy.start([]).pipe(
            Effect.as(proxy),
            Effect.onError(() =>
              proxy.stop(lifetime.deadline()).pipe(Effect.ignore),
            ),
          )
        }),
        // Stopped after the runtimes, so probes report the shutdown to the end.
        (proxy) =>
          releaseStep(
            'Neem server stop',
            proxy.stop(lifetime.deadline()),
            lifetime.deadline(),
          ),
      ).pipe(Scope.provide(lifetime.scope))

      const background = yield* callbackRunner(lifetime)
      subsystems.runBackground = background

      // Registered last, so the runtimes stop first, side by side.
      yield* Scope.addFinalizer(
        lifetime.scope,
        Effect.suspend(() =>
          Effect.forEach(
            [...subsystems.runtimes.values()],
            (runtime) => this.stopRuntime(runtime, lifetime.deadline(), true),
            { concurrency: 'unbounded', discard: true },
          ),
        ),
      )

      yield* this.serverHook('server:start')
      for (const runtimeName of Object.keys(snapshot.manifest.runtimes)) {
        subsystems.runtimes.set(runtimeName, this.createRuntime(runtimeName))
      }
      yield* Effect.forEach(
        subsystems.runtimes.values(),
        (runtime) => runtime.start(),
        {
          concurrency: 'unbounded',
          discard: true,
        },
      )
      yield* this.syncProxy()
      this.markSettled()
      yield* this.serverHook(readyHook)
      this.logger.trace(this.getSnapshot(), 'Neem server snapshot')
    }).pipe(
      Effect.catch((error) =>
        Effect.gen({ self: this }, function* () {
          this.markState('failed', error)
          this.logger.error({ err: error }, failMessage)
          yield* this.failHook(error)
          yield* this.releaseSubsystems()
          return yield* Effect.fail(error)
        }),
      ),
    )
  }

  // Closes what the last bring-up acquired; reports instead of failing, since
  // a replacement or a failure report follows either way.
  private releaseSubsystems(): Effect.Effect<void> {
    return this.closeSubsystems(this.freshDeadline()).pipe(
      Effect.flatMap((errors) =>
        Effect.sync(() => {
          for (const error of errors) {
            this.logger.error(
              { err: error },
              'Neem server did not stop cleanly',
            )
          }
        }),
      ),
    )
  }

  private closeSubsystems(deadline: Deadline): Effect.Effect<readonly Error[]> {
    return Effect.suspend(() => {
      const subsystems = this.subsystems
      if (!subsystems) return Effect.succeed([])
      return subsystems.lifetime.close(deadline).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.subsystems === subsystems) this.subsystems = undefined
          }),
        ),
      )
    })
  }

  // In a finalizer, release failures must be defects of the release; as a
  // step of an operation they are reported.
  private stopRuntime(
    runtime: RuntimeSupervisor,
    deadline: Deadline,
    asRelease = false,
  ): Effect.Effect<void> {
    return runtime.stop(deadline).pipe(
      Effect.flatMap((errors) => {
        if (errors.length === 0) return Effect.void
        if (asRelease) {
          return Effect.failCause(
            Cause.fromReasons<never>(
              errors.map((error) => Cause.makeDieReason(error)),
            ),
          )
        }
        return Effect.sync(() => {
          for (const error of errors) {
            this.logger.error(
              { err: error },
              'Neem runtime did not stop cleanly before its replacement',
            )
          }
        })
      }),
    )
  }

  private createRuntime(runtimeName: string): RuntimeSupervisor {
    const { prepareRecovery } = this.options
    return new RuntimeSupervisor({
      context: this.context,
      snapshot: this.snapshot,
      runtimeName,
      recovery: this.options.recovery,
      prepareRecovery: prepareRecovery && (() => prepareRecovery(runtimeName)),
      onRecovered: () => {
        this.subsystems?.runBackground?.(
          this.syncProxy().pipe(
            Effect.tap(() =>
              Effect.sync(() => this.options.onRuntimeRecovered?.(runtimeName)),
            ),
          ),
        )
      },
      onUpstreamsChange: () => this.syncProxy(),
      // Syncing upstreams publishes health too: a recovered runtime is ready
      // before its new upstreams are routed.
      onStateChange: () =>
        void this.subsystems?.runBackground?.(this.syncProxy()),
      onFailure: (error) => {
        if (!this.failOnWorkerError()) return
        this.markState('failed', error)
        this.options.onFailure?.(error, runtimeName)
      },
    })
  }

  // Ends a successful operation. A runtime that failed while it ran keeps the
  // server failed rather than being overwritten by the operation's success.
  private markSettled(): void {
    const failed = this.failOnWorkerError()
      ? this.runtimeList().find((runtime) => runtime.getState() === 'failed')
      : undefined
    if (failed) this.markState('failed', failed.getLastError())
    else this.markState('running')
  }

  // Proxy reconcile failures are logged and retried by the proxy itself; a
  // runtime's failure or recovery must not fail on them.
  private syncProxy(): Effect.Effect<void> {
    return Effect.suspend(() => {
      const subsystems = this.subsystems
      const proxy = subsystems?.proxy
      if (!subsystems || !proxy) return Effect.void
      const upstreams = [...subsystems.runtimes.values()].map((runtime) => ({
        runtimeName: runtime.name,
        upstreams: runtime.getUpstreams(),
      }))
      return proxy.setUpstreams(upstreams).pipe(Effect.ignore)
    })
  }

  private runtimeList(): readonly RuntimeSupervisor[] {
    return [...(this.subsystems?.runtimes.values() ?? [])]
  }

  private failOnWorkerError(): boolean {
    return this.options.failOnWorkerError ?? this.snapshot.mode === 'production'
  }

  private freshDeadline(): Deadline {
    return Deadline.after(lifecycleOf(this.snapshot).stopTimeout, this.clock)
  }

  // Runtimes keep the snapshot they started from until they are reloaded, so
  // a recovery restarts a runtime from the same output as its siblings.
  private replaceSnapshot(snapshot: RuntimeSnapshot): void {
    this.snapshot = snapshot
    this.logger = childLogger(snapshot.logger, 'neem:server')
  }

  // Only the stop ends `stopping`: an operation or runtime failure settling
  // after the stop began must not move the server to another state.
  private markState(state: NeemRuntimeServerState, error?: Error): void {
    if (this.state === 'stopping' && state !== 'stopped') return
    const previous = this.state
    this.state = state
    this.lastError = error
    this.revision++
    this.subsystems?.proxy?.publishHealth()
    this.logger.debug(`Neem server state: ${previous} -> ${state}`)
  }

  private serverHook(
    name: 'server:start' | 'server:ready' | 'server:reload',
  ): Effect.Effect<void, Error> {
    return callHook(this.hooks, this.logger, name, { mode: this.snapshot.mode })
  }

  private failHook(error: Error): Effect.Effect<void> {
    return callHook(this.hooks, this.logger, 'server:fail', {
      mode: this.snapshot.mode,
      error,
    }).pipe(
      Effect.catch((hookError) =>
        Effect.sync(() =>
          this.logger.warn(
            new Error('Neem server fail hook failed', { cause: hookError }),
          ),
        ),
      ),
    )
  }
}

const disabledProxyHealth: NeemProxyHealth = {
  running: false,
  ready: false,
  upstreams: [],
  appliedUpstreams: [],
  pending: 0,
  failedUpstreams: [],
}
