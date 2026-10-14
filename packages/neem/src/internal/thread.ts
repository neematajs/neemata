import type { MessagePort } from 'node:worker_threads'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MessageChannel } from 'node:worker_threads'

import type * as Fiber from 'effect/Fiber'
import type { Logger } from 'pino'
import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Scope from 'effect/Scope'

import type {
  NeemResolvedArtifact,
  NeemRuntimeThreadHandle,
  NeemRuntimeUpstream,
  NeemStartedRuntimeThreadHealth,
  NeemWorkerState,
} from '../shared/types.ts'
import type { WorkerUpdate } from './build/updates.ts'
import type { HostContext } from './context.ts'
import type { Lifetime } from './lifetime.ts'
import type { RuntimeSnapshot } from './manifest/snapshot.ts'
import type {
  ThreadWorkerData,
  WorkerPatchResult,
  WorkerStartFailure,
} from './protocol.ts'
import type { SpawnedWorker } from './transport.ts'
import { NeemWorkerError } from '../shared/errors.ts'
import { hostSettings } from './config.ts'
import { callHook, lifecycleOf, requestError } from './context.ts'
import { createRuntimeEnv } from './host/env.ts'
import { DEFAULT_REQUEST_TIMEOUT_MS } from './host/lifecycle.ts'
import { releaseStep } from './lifetime.ts'
import { childLogger, runtimeLabel } from './logger.ts'
import { ThreadRpcs } from './protocol.ts'
import { callbackRunner } from './tasks.ts'
import { spawnWorker } from './transport.ts'
import { deserializeError } from './utils.ts'

export type ThreadPlan = {
  name: string
  artifact: NeemResolvedArtifact
  data?: unknown
}

export type ThreadOptions = {
  context: HostContext
  snapshot: RuntimeSnapshot
  runtimeName: string
  plan: ThreadPlan
  index: number
  /** Reports a failure after readiness; the runtime decides what follows. */
  onFailure: (error: Error, thread: Thread) => void
}

/**
 * One runtime worker thread. `start` acquires it into a lifetime and waits for
 * readiness; closing that lifetime stops it within the lifetime's deadline.
 */
export class Thread {
  readonly id: string
  readonly runtimeName: string
  readonly name: string
  readonly artifact: NeemResolvedArtifact
  /** The runner's end of the channel to this thread. */
  private channel: MessageChannel | undefined
  get port(): MessagePort {
    return this.channel!.port1
  }
  patches = 0

  private readonly options: ThreadOptions
  private readonly logger: Logger
  private get transferPort(): MessagePort {
    return this.channel!.port2
  }
  private clock = Effect.runSync(Clock.Clock)
  private runBackground:
    | ((effect: Effect.Effect<void>) => Fiber.Fiber<void>)
    | undefined
  private worker: SpawnedWorker<ThreadRpcs> | undefined
  // Fails readiness when the worker dies or reports an error before it.
  private readonly startFailure = Deferred.makeUnsafe<never, Error>()
  private state: NeemWorkerState = 'idle'
  private failureCount = 0
  private startedAt: number | undefined
  private readyAt: number | undefined
  private stoppedAt: number | undefined
  private lastError: Error | undefined
  private upstreams: readonly NeemRuntimeUpstream[] = []

  constructor(options: ThreadOptions) {
    const { plan, runtimeName, index, snapshot } = options
    this.options = options
    this.runtimeName = runtimeName
    this.name = plan.name
    this.artifact = plan.artifact
    this.id = `${runtimeName}:${plan.name}:${index}`
    this.logger = childLogger(
      snapshot.logger,
      runtimeLabel(runtimeName, plan.name),
    )
  }

  getHandle(): NeemRuntimeThreadHandle {
    return { name: this.name, port: this.port }
  }

  getState(): NeemWorkerState {
    return this.state
  }

  getUpstreams(): readonly NeemRuntimeUpstream[] {
    return this.upstreams
  }

  getHealth(): NeemStartedRuntimeThreadHealth {
    return {
      id: this.id,
      name: this.name,
      artifactId: this.artifact.id,
      state: this.state,
      failureCount: this.failureCount,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      stoppedAt: this.stoppedAt,
      lastError: this.lastError,
      runtimeName: this.runtimeName,
      artifact: this.artifact,
      upstreams: this.upstreams,
    }
  }

  /**
   * Starts the worker inside `lifetime` and waits until it is ready. An
   * interrupted start leaves the worker to the lifetime, which stops it.
   */
  start(lifetime: Lifetime): Effect.Effect<void, Error> {
    const { snapshot } = this.options
    const { startTimeout } = lifecycleOf(snapshot)
    return Effect.gen({ self: this }, function* () {
      this.clock = yield* Clock.Clock
      this.runBackground = yield* callbackRunner(lifetime)
      this.channel = yield* Effect.acquireRelease(
        Effect.sync(() => new MessageChannel()),
        (channel) =>
          Effect.sync(() => {
            channel.port1.close()
            channel.port2.close()
          }),
      ).pipe(Scope.provide(lifetime.scope))
      // Registered first, so it runs once the worker is gone.
      yield* Scope.addFinalizer(lifetime.scope, this.finishStop(lifetime))
      yield* this.hook('worker:start')
      this.state = 'starting'
      this.startedAt = this.clock.currentTimeMillisUnsafe()
      this.logger.trace(
        { artifactId: this.artifact.id },
        'Neem worker starting',
      )
      const env = createRuntimeEnv({
        manifest: snapshot.manifest,
        runtimeName: this.runtimeName,
        overrideEnv: snapshot.env,
      })
      const settings = yield* hostSettings(env)
      const worker = yield* spawnWorker(lifetime, {
        label: `Worker [${this.name}]`,
        entry: snapshot.workerEntry,
        workerData: this.workerData(),
        transferList: [this.transferPort],
        env: createRuntimeEnv({
          manifest: snapshot.manifest,
          runtimeName: this.runtimeName,
          overrideEnv: snapshot.env,
        }),
        group: ThreadRpcs,
        tracing: settings.tracing,
        registry: this.options.context.registry,
        describeFatal: (fatal) =>
          new NeemWorkerError({
            worker: this.name,
            origin: fatal.origin,
            cause: deserializeError(fatal),
          }),
        onFailure: (error) => this.fail(error),
        onExit: () => this.onExit(),
        requestExit: (client, timeoutMs) =>
          client.stop({ timeoutMs }, { discard: true }),
      })
      this.worker = worker
      // Registered last, so it runs first: nothing routes to a stopping worker.
      yield* Scope.addFinalizer(
        lifetime.scope,
        Effect.sync(() => {
          if (this.state === 'stopped') return
          this.state = 'stopping'
          this.upstreams = []
          this.logger.trace('Neem worker stopping')
        }),
      )
      const ready = yield* worker.client.start().pipe(
        Effect.mapError((error) => this.startError(error)),
        Effect.raceFirst(Deferred.await(this.startFailure)),
        Effect.timeoutOrElse({
          duration: startTimeout,
          orElse: () =>
            Effect.fail(
              new Error(
                `Worker [${this.name}] did not become ready within ${startTimeout}ms`,
              ),
            ),
        }),
      )
      this.markReady(ready)
      yield* this.hook('worker:ready')
      // A failure during the hook already reported itself.
      if (this.getState() === 'failed') {
        return yield* Effect.fail(this.lastError!)
      }
      this.logger.trace(
        { upstreams: this.upstreams.length },
        'Neem worker ready',
      )
    }).pipe(
      Effect.tapError((error) =>
        Effect.suspend(() => {
          // A failure after readiness was reported when it happened.
          if (this.state === 'failed' && this.readyAt !== undefined) {
            return Effect.void
          }
          if (this.state !== 'failed') this.markFailed(error)
          return this.failHook(error)
        }),
      ),
    )
  }

  /** Applies one development update; fails when no reply came. */
  applyPatch(update: WorkerUpdate): Effect.Effect<WorkerPatchResult, Error> {
    const worker = this.worker
    if (this.state !== 'ready' || !worker) {
      return Effect.succeed({
        outcome: 'rejected',
        delivered: false,
        patches: this.patches,
        reason: `Worker [${this.name}] is not ready`,
      })
    }
    const url =
      update.type === 'Patch'
        ? pathToFileURL(resolve(this.artifact.outDir, update.filename)).href
        : undefined
    return worker.client.patch({ update, url }).pipe(
      Effect.mapError(requestError),
      Effect.timeoutOrElse({
        duration: DEFAULT_REQUEST_TIMEOUT_MS,
        orElse: () =>
          Effect.fail(
            new Error(
              `Worker [${this.name}] patch timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms`,
            ),
          ),
      }),
      Effect.tap((result) =>
        Effect.sync(() => {
          this.patches = result.patches
        }),
      ),
    )
  }

  /**
   * Fails a ready worker that can no longer serve although its thread still
   * runs, exactly as if it had crashed.
   */
  reportFailure(error: Error): void {
    this.fail(error)
  }

  private fail(error: Error): void {
    if (this.state === 'failed' || this.state === 'stopped') return
    const previous = this.state
    this.markFailed(error)
    if (previous !== 'ready') {
      // Before readiness the start reports it; while stopping, the stop does.
      Deferred.doneUnsafe(this.startFailure, Effect.fail(error))
      return
    }
    this.runBackground?.(this.failHook(error))
    this.options.onFailure(error, this)
  }

  private markReady(upstreams: readonly NeemRuntimeUpstream[]): void {
    // A stop may already be under way; its worker must not advertise upstreams.
    if (this.state !== 'starting') return
    this.upstreams = upstreams
    this.state = 'ready'
    this.readyAt = this.clock.currentTimeMillisUnsafe()
    this.options.context.onThreadEvent?.({
      type: 'thread-started',
      runtimeName: this.runtimeName,
      threadId: this.id,
    })
  }

  private markFailed(error: Error): void {
    this.failureCount += 1
    this.lastError = error
    this.state = 'failed'
    // A failed worker exits; advertising its upstreams would route to nothing.
    this.upstreams = []
    this.logger.error({ err: error }, 'Neem worker failed')
  }

  // Only a worker that announced itself as a patch client leaves as one.
  private onExit(): void {
    if (this.readyAt === undefined) return
    this.options.context.onThreadEvent?.({
      type: 'thread-stopped',
      runtimeName: this.runtimeName,
      threadId: this.id,
    })
  }

  private finishStop(lifetime: Lifetime): Effect.Effect<void> {
    return Effect.suspend(() => {
      const spawned = this.worker !== undefined
      this.port.close()
      if (!spawned) this.transferPort.close()
      this.upstreams = []
      this.state = 'stopped'
      this.stoppedAt = this.clock.currentTimeMillisUnsafe()
      if (!spawned) return Effect.void
      this.logger.trace('Neem worker stopped')
      return releaseStep(
        `Worker [${this.name}] hook [worker:stop]`,
        this.hook('worker:stop'),
        lifetime.deadline(),
      )
    })
  }

  private startError(error: WorkerStartFailure | RpcClientError): Error {
    if (error instanceof RpcClientError) return requestError(error)
    return new NeemWorkerError({
      worker: this.name,
      origin: error.origin,
      cause: error.error,
    })
  }

  private workerData(): ThreadWorkerData {
    const { snapshot, runtimeName, plan } = this.options
    return {
      mode: snapshot.mode,
      runtimeName,
      name: plan.name,
      data: plan.data,
      artifact: plan.artifact,
      outDir: snapshot.outDir,
      logger: snapshot.manifest.config.logger,
      port: this.transferPort,
      patchClientId: this.id,
    }
  }

  private hook(
    name: 'worker:start' | 'worker:ready' | 'worker:stop' | 'worker:fail',
    error?: Error,
  ): Effect.Effect<void, Error> {
    const { context, snapshot } = this.options
    return callHook(context.hooks, snapshot.logger, name, {
      mode: snapshot.mode,
      id: this.id,
      name: this.name,
      artifactId: this.artifact.id,
      owner: this.artifact.owner,
      error,
    })
  }

  private failHook(error: Error): Effect.Effect<void> {
    return this.hook('worker:fail', error).pipe(
      Effect.catch((hookError) =>
        Effect.sync(() =>
          this.logger.warn(
            new Error('Neem worker fail hook failed', { cause: hookError }),
          ),
        ),
      ),
    )
  }
}
