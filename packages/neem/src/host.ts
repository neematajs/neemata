import type * as Scope from 'effect/Scope'
import * as Effect from 'effect/Effect'

import type { HostOptions } from './internal/host.ts'
import type { LoadRuntimeSnapshotOptions } from './internal/host/bootstrap.ts'
import type { RuntimeSnapshot } from './internal/manifest/snapshot.ts'
import { lifecycleOf } from './internal/context.ts'
import { Host } from './internal/host.ts'
import { Deadline } from './internal/lifetime.ts'
import { loadSnapshot as load } from './internal/snapshot.ts'

export type LoadSnapshotOptions = LoadRuntimeSnapshotOptions
export type { RuntimeSnapshot } from './internal/manifest/snapshot.ts'

/** Loads and validates a build for this host before importing its artifacts. */
export const loadSnapshot = (
  options: LoadSnapshotOptions,
): Effect.Effect<RuntimeSnapshot, Error> => load(options)

/**
 * Serves a built output for the lifetime of the enclosing scope: started when
 * acquired, stopped within `lifecycle.stopTimeout` when the scope closes. A
 * stop that fails is a defect of the scope's close.
 */
export const serve = (
  snapshot: RuntimeSnapshot,
  options: Omit<HostOptions, 'snapshot'> = {},
): Effect.Effect<Host, Error, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new Host({ ...options, snapshot })),
    (host) =>
      Deadline.make(lifecycleOf(snapshot).stopTimeout).pipe(
        Effect.flatMap((deadline) => host.stop(deadline)),
        Effect.orDie,
      ),
  ).pipe(Effect.tap((host) => host.start()))

export { Host } from './internal/host.ts'
export type { HostOptions } from './internal/host.ts'
export { Deadline } from './internal/lifetime.ts'
export { runHostUntilClosed } from './bootstrap.ts'
export { HostController } from './internal/host/controller.ts'
export { startStandalone } from './internal/standalone/entry.ts'
export type { StandaloneStartOptions } from './internal/standalone/entry.ts'

export { HostHooks, createHostHooks } from './internal/hooks.ts'
export type { PluginHooks } from './internal/hooks.ts'
