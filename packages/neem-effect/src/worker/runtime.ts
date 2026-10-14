import { isDeepStrictEqual } from 'node:util'

import type {
  NeemMode,
  NeemRuntime,
  NeemRuntimeUpstream,
  NeemRuntimeWorker,
  NeemRuntimeWorkerContext,
} from '@nmtjs/neem/internal/shared/types'
import { normalizeError } from '@nmtjs/neem/internal/utils'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'

import type { Deadline } from '../internal/lifetime.ts'
import type { WorkerStartFailure } from '../internal/protocol.ts'
import {
  attempt,
  causeErrors,
  closeWithin,
  within,
} from '../internal/lifetime.ts'
import { parseRuntimeStartResult } from '../internal/runtime-schema.ts'

/** One runtime the user's worker created, and the scope that stops it. */
type Generation = {
  readonly scope: Scope.Closeable
  readonly runtime: NeemRuntime
}

export type Bootstrap = {
  worker: NeemRuntimeWorker
  context: NeemRuntimeWorkerContext
}

export type WorkerRuntimeOptions = {
  mode: NeemMode
  /** The running generation ended although nobody stopped it. */
  onFinished: (error: Error) => void
  onStartError: (error: Error, origin: WorkerStartFailure['origin']) => void
  onCleanupError: (error: Error) => void
}

/**
 * Owns the user's runtime inside a worker thread. Every generation lives in a
 * child scope of the worker's root, so stopping the worker releases whatever
 * exists, including a runtime whose factory resolves after the stop: it is
 * released as soon as it is acquired. In development a patch replaces the
 * generation without restarting the thread.
 */
export class WorkerRuntime {
  /** The first start: upstreams, or why the runtime did not come up. */
  readonly ready = Deferred.makeUnsafe<
    readonly NeemRuntimeUpstream[],
    WorkerStartFailure
  >()

  private readonly root = Scope.makeUnsafe()
  // Patches build on each other, so one runs at a time.
  private readonly patchPermit = Semaphore.makeUnsafe(1)
  private readonly options: WorkerRuntimeOptions
  private booting: Fiber.Fiber<unknown, unknown> | undefined
  private current: Generation | undefined
  private worker: NeemRuntimeWorker | undefined
  private context: NeemRuntimeWorkerContext | undefined
  private upstreams: readonly NeemRuntimeUpstream[] = []
  private replacing = false
  private stopped = false

  constructor(options: WorkerRuntimeOptions) {
    this.options = options
  }

  /** Starts the first generation as soon as the thread boots. */
  boot(load: Effect.Effect<Bootstrap, Error>): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      this.booting = yield* Effect.forkIn(
        this.start(load).pipe(
          Effect.onExit((exit) => Deferred.done(this.ready, exit)),
        ),
        this.root,
      )
    })
  }

  /**
   * Why a generation reload would be refused right now, before the patch
   * client touches anything.
   */
  refusal(): string | undefined {
    if (this.worker?.reload === 'thread') {
      return "Worker requires reload: 'thread'"
    }
    if (this.options.mode !== 'development') {
      return 'Worker generation reload is only available in development'
    }
    if (this.stopped) return 'Neem runtime stopped'
    if (this.replacing) return 'Neem runtime is already reloading'
    return undefined
  }

  /**
   * Runs one patch. Waiting for the previous patch can be interrupted; once
   * this one runs, it runs to the end even if the host stops waiting, since
   * the next patch builds on what it leaves behind.
   */
  patch<A>(apply: Effect.Effect<A>): Effect.Effect<A> {
    return this.patchPermit.withPermit(Effect.uninterruptible(apply))
  }

  /**
   * Replaces the running generation with one from `next`. Anything failing
   * after the old generation stopped leaves none serving.
   */
  replace(next: NeemRuntimeWorker): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const refusal = this.refusal()
      if (refusal) return yield* Effect.fail(new Error(refusal))
      if (next.reload === 'thread') {
        return yield* Effect.fail(
          new Error("Updated worker requires reload: 'thread'"),
        )
      }
      this.replacing = true
      const previous = this.current
      if (previous) {
        this.current = undefined
        const errors = yield* closeScope(previous.scope)
        if (errors.length > 0) return yield* Effect.fail(aggregate(errors))
      }
      const context = { ...this.context!, definition: next.definition }
      const generation = yield* this.acquire(next, context)
      const upstreams = yield* this.startGeneration(generation)
      if (!isDeepStrictEqual(upstreams, this.upstreams)) {
        yield* this.discard(generation)
        return yield* Effect.fail(
          new Error(
            'Worker update changed runtime upstreams; a runtime restart is required',
          ),
        )
      }
      this.worker = next
      this.context = context
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          this.replacing = false
        }),
      ),
    )
  }

  /**
   * Stops whatever runs, joining a first start or a patch still acquiring a
   * generation, all within the deadline. Resolves with every error.
   */
  stop(deadline: Deadline): Effect.Effect<readonly Error[]> {
    return Effect.gen({ self: this }, function* () {
      this.stopped = true
      const errors: Error[] = []
      // The interrupt only ends waits; an acquisition in flight completes and
      // is released at once, inside the fiber joined here.
      if (this.booting) {
        yield* within(Fiber.interrupt(this.booting), deadline)
      }
      errors.push(
        ...(yield* closeWithin('Neem runtime stop', this.root, deadline)),
      )
      // A patch replacing the generation owns what it acquires after the close.
      const settled = yield* within(
        this.patchPermit.withPermit(Effect.void),
        deadline,
      )
      if (settled._tag === 'None') {
        errors.push(new Error('A worker patch did not settle before the stop'))
      }
      return errors
    })
  }

  private start(
    load: Effect.Effect<Bootstrap, Error>,
  ): Effect.Effect<readonly NeemRuntimeUpstream[], WorkerStartFailure> {
    return Effect.gen({ self: this }, function* () {
      const { worker, context } = yield* load
      this.worker = worker
      this.context = context
      return yield* this.acquire(worker, context)
    }).pipe(
      Effect.mapError((error) => this.startFailure('bootstrap', error)),
      Effect.flatMap((generation) =>
        this.startGeneration(generation).pipe(
          Effect.mapError((error) => this.startFailure('start', error)),
        ),
      ),
      Effect.tap((upstreams) =>
        Effect.sync(() => {
          this.upstreams = upstreams
        }),
      ),
    )
  }

  private startFailure(
    origin: WorkerStartFailure['origin'],
    error: Error,
  ): WorkerStartFailure {
    this.options.onStartError(error, origin)
    return { error: normalizeError(error), origin }
  }

  // Published as current before it starts, so a stop reaches a generation
  // whose start is still pending.
  private acquire(
    worker: NeemRuntimeWorker,
    context: NeemRuntimeWorkerContext,
  ): Effect.Effect<Generation, Error> {
    return Effect.suspend(() => {
      if (this.stopped) {
        return Effect.fail(new Error('Neem runtime stopped'))
      }
      const scope = Scope.forkUnsafe(this.root)
      return Effect.acquireRelease(
        attempt(() => worker.createRuntime(context)),
        (runtime) => attempt(() => runtime.stop()).pipe(Effect.orDie),
      ).pipe(
        Scope.provide(scope),
        Effect.map((runtime) => {
          const generation = { scope, runtime }
          this.current = generation
          return generation
        }),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      )
    })
  }

  // A generation that fails to start is stopped before the failure is
  // reported; the runtime may have acquired resources on its way.
  private startGeneration(
    generation: Generation,
  ): Effect.Effect<readonly NeemRuntimeUpstream[], Error> {
    return attempt(() => generation.runtime.start()).pipe(
      Effect.flatMap((result) =>
        Effect.try({
          try: () => parseRuntimeStartResult(result),
          catch: normalizeError,
        }),
      ),
      Effect.tap(() => this.watch(generation)),
      Effect.tapError(() => this.discard(generation)),
    )
  }

  private discard(generation: Generation): Effect.Effect<void> {
    if (this.current === generation) this.current = undefined
    return closeScope(generation.scope).pipe(
      Effect.flatMap((errors) =>
        Effect.sync(() => {
          for (const error of errors) this.options.onCleanupError(error)
        }),
      ),
    )
  }

  // A runtime that settles `finished` before anyone stopped it is a failure:
  // a ready worker must not become a silent zombie. Closing the generation
  // interrupts this watch before it stops the runtime.
  private watch(generation: Generation): Effect.Effect<void> {
    const { finished } = generation.runtime
    if (!finished) return Effect.void
    return attempt(() => finished).pipe(
      Effect.match({
        onSuccess: () =>
          new Error('Neem runtime finished before stop was requested'),
        onFailure: (error) => error,
      }),
      Effect.flatMap((error) =>
        Effect.sync(() => {
          if (!this.stopped && this.current === generation) {
            this.options.onFinished(error)
          }
        }),
      ),
      Effect.forkIn(generation.scope),
      Effect.asVoid,
    )
  }
}

function closeScope(scope: Scope.Closeable): Effect.Effect<readonly Error[]> {
  return Effect.exit(Scope.close(scope, Exit.void)).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? causeErrors(exit.cause) : [])),
  )
}

function aggregate(errors: readonly Error[]): Error {
  return errors.length === 1
    ? errors[0]!
    : new AggregateError(
        errors,
        errors.map((error) => error.message).join('; '),
      )
}
