import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as FiberHandle from 'effect/FiberHandle'
import * as Option from 'effect/Option'
import * as Schedule from 'effect/Schedule'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import type {
  NeemProxyHealth,
  NeemProxyUpstreamSnapshot,
  NeemProxyUpstreamFailure,
} from '../shared/types.ts'
import type { HealthStatus } from './host/health.ts'
import type { RuntimeSnapshot } from './manifest/snapshot.ts'
import {
  createDesiredUpstreams,
  createNativeProxyOptions,
  filterRuntimeUpstreams,
  formatProxyListenUrl,
  loadProxyPackage,
  resolveServerConfig,
  upstreamKey,
  type NativeProxy,
  type RuntimeUpstreams,
} from './host/proxy-config.ts'
import { attempt, closeWithin, type Deadline } from './lifetime.ts'
import { childLogger } from './logger.ts'

/** Effect owns reconciliation; the native proxy still owns request forwarding. */
export class ProxyController {
  private readonly config
  private readonly logger
  private readonly mutations = Semaphore.makeUnsafe(1)
  private readonly scope = Scope.makeUnsafe()
  private retry: FiberHandle.FiberHandle<void, never> | undefined
  private proxy: NativeProxy | undefined
  private running = false
  private stopping = false
  private desired = new Map<string, NeemProxyUpstreamSnapshot>()
  private applied = new Map<string, NeemProxyUpstreamSnapshot>()
  private failures = new Map<string, NeemProxyUpstreamFailure>()
  private mutating = false
  private pending = 0
  private publishedHealth: HealthStatus | undefined

  private readonly snapshot: RuntimeSnapshot
  private readonly options: { getHealthStatus?: () => HealthStatus }
  constructor(
    snapshot: RuntimeSnapshot,
    options: { getHealthStatus?: () => HealthStatus } = {},
  ) {
    this.snapshot = snapshot
    this.options = options
    this.config = resolveServerConfig(snapshot.config.server, snapshot.mode)
    this.logger = childLogger(snapshot.logger, 'neem:server')
  }

  start(upstreams: readonly RuntimeUpstreams[]): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      this.retry = yield* FiberHandle.make<void, never>().pipe(
        Scope.provide(this.scope),
      )
      const { Proxy } = yield* attempt(loadProxyPackage)
      this.proxy = yield* Effect.acquireRelease(
        attempt(
          () =>
            new Proxy(
              createNativeProxyOptions(
                this.config,
                this.snapshot.config.runtimes,
              ),
            ),
        ),
        (proxy) => attempt(() => proxy.stop()).pipe(Effect.orDie),
      ).pipe(Scope.provide(this.scope))
      this.desired = createDesiredUpstreams(
        filterRuntimeUpstreams(upstreams, this.snapshot.config.runtimes),
      )
      yield* this.reconcile()
      yield* attempt(() => this.proxy!.start())
      this.running = true
      let address = this.config
      try {
        address = this.proxy.address() ?? this.config
      } catch {
        /* Address inspection must not undo a running server. */
      }
      this.logger.info(
        `Neem server listening on [${formatProxyListenUrl(address, Boolean(this.config.tls))}]`,
      )
    })
  }

  stop(deadline: Deadline): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      this.stopping = true
      this.running = false
      // A native mutation cannot be cancelled. Keep ownership until it settles,
      // but bound the caller's wait and still request native shutdown afterwards.
      const draining = yield* Effect.forkDetach(
        this.mutations.withPermit(Effect.void),
      )
      const drain = yield* Effect.timeoutOption(
        Fiber.await(draining),
        deadline.remaining(),
      )
      const errors = [
        ...(yield* closeWithin('Proxy shutdown', this.scope, deadline)),
      ]
      if (Option.isNone(drain))
        errors.push(
          new Error('Proxy mutations did not settle before the stop deadline'),
        )
      this.proxy = undefined
      this.desired.clear()
      this.applied.clear()
      this.failures.clear()
      if (errors.length)
        return yield* Effect.fail(
          new AggregateError(errors, errors.map((e) => e.message).join('; ')),
        )
    })
  }

  setUpstreams(
    upstreams: readonly RuntimeUpstreams[],
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      if (this.stopping) return
      this.desired = createDesiredUpstreams(
        filterRuntimeUpstreams(upstreams, this.snapshot.config.runtimes),
      )
      this.publishHealth()
      const result = yield* Effect.exit(this.reconcile())
      if (Exit.isFailure(result)) {
        if (this.retry && !this.stopping) {
          const policy = Schedule.exponential(200).pipe(
            Schedule.modifyDelay(({ duration }) =>
              Effect.succeed(Math.min(Duration.toMillis(duration), 5_000)),
            ),
          )
          yield* FiberHandle.run(
            this.retry,
            Effect.sleep(100).pipe(
              Effect.andThen(this.reconcile().pipe(Effect.retry(policy))),
              Effect.ignore,
            ),
          )
        }
        return yield* result
      }
      if (this.retry) yield* FiberHandle.clear(this.retry)
    })
  }

  private reconcile(): Effect.Effect<void, Error> {
    return Effect.suspend(() => {
      this.pending++
      return this.mutations
        .withPermit(
          Effect.gen({ self: this }, function* () {
            if (!this.proxy || this.stopping) return
            for (const key of this.failures.keys())
              if (this.desired.has(key) === this.applied.has(key))
                this.failures.delete(key)
            const removals = [...this.applied.values()].filter(
              (u) => !this.desired.has(upstreamKey(u)),
            )
            const additions = [...this.desired.values()].filter(
              (u) => !this.applied.has(upstreamKey(u)),
            )
            this.mutating = removals.length + additions.length > 0
            const errors: Error[] = []
            for (const [operation, upstreams] of [
              ['remove', removals],
              ['add', additions],
            ] as const) {
              for (const upstream of upstreams) {
                const key = upstreamKey(upstream)
                const proxy = this.proxy
                const result = yield* Effect.exit(
                  attempt(() =>
                    operation === 'add'
                      ? proxy.addUpstream(
                          upstream.runtimeName,
                          upstream.proxyUpstream,
                        )
                      : proxy.removeUpstream(
                          upstream.runtimeName,
                          upstream.proxyUpstream,
                        ),
                  ),
                )
                if (Exit.isFailure(result)) {
                  const error =
                    result.cause.reasons.flatMap((r) =>
                      r._tag === 'Fail' ? [r.error] : [],
                    )[0] ?? new Error('Proxy mutation failed')
                  this.failures.set(key, { operation, upstream, error })
                  errors.push(error)
                } else {
                  if (operation === 'add') this.applied.set(key, upstream)
                  else this.applied.delete(key)
                  this.failures.delete(key)
                }
              }
            }
            if (errors.length) return yield* Effect.fail(errors[0]!)
          }).pipe(
            Effect.uninterruptible,
            Effect.ensuring(
              Effect.sync(() => {
                this.mutating = false
              }),
            ),
          ),
        )
        .pipe(
          Effect.tapError((error) =>
            Effect.sync(() =>
              this.logger.warn(
                { err: error },
                'Failed to reconcile proxy upstreams',
              ),
            ),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              this.pending--
              this.publishHealth()
            }),
          ),
        )
    })
  }

  publishHealth(): void {
    if (!this.proxy || !this.running || !this.options.getHealthStatus) return
    const status = this.options.getHealthStatus()
    if (
      this.publishedHealth?.healthy === status.healthy &&
      this.publishedHealth.ready === status.ready
    )
      return
    try {
      this.proxy.setHealth(status)
      this.publishedHealth = status
    } catch (error) {
      this.logger.warn({ err: error }, 'Failed to publish Neem server health')
    }
  }

  getHealth(): NeemProxyHealth {
    const upstreams = [...this.desired.values()],
      appliedUpstreams = [...this.applied.values()],
      failedUpstreams = [...this.failures.values()]
    return {
      running: this.running,
      ready:
        this.running &&
        !this.mutating &&
        failedUpstreams.length === 0 &&
        upstreams.length === appliedUpstreams.length &&
        upstreams.every((u) => this.applied.has(upstreamKey(u))),
      upstreams,
      appliedUpstreams,
      failedUpstreams,
      pending: this.pending,
      lastError: failedUpstreams.at(-1)?.error,
    }
  }
}
