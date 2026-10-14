import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Scope from 'effect/Scope'

import type {
  NeemPluginHooksContext as PluginContext,
  NeemRuntimeServerHealth,
} from '../shared/types.ts'
import type { HostHooks, PluginHooks } from './hooks.ts'
import type { Lifetime } from './lifetime.ts'
import type { RuntimeSnapshot } from './manifest/snapshot.ts'
import { invoke } from './hooks.ts'
import { attempt, boundedScope, releaseStep } from './lifetime.ts'
import { importDefault } from './utils.ts'

export type PluginFactory<Options = unknown> = (
  context: PluginContext<Options>,
) =>
  | PluginHooks
  | PromiseLike<PluginHooks>
  | Effect.Effect<PluginHooks, Error, Scope.Scope>

/** Each acquired plugin gets cleanup immediately, including partial startup. */
export const acquirePlugins = (
  snapshot: RuntimeSnapshot,
  hooks: HostHooks,
  lifetime: Lifetime,
  getHealth: () => NeemRuntimeServerHealth,
) =>
  Effect.gen(function* () {
    // Registered first, so plugin-owned callbacks have been removed by disposal.
    yield* Scope.addFinalizer(
      lifetime.scope,
      Effect.suspend(() =>
        releaseStep(
          'Host hook disposal',
          hooks.call(snapshot.logger, 'dispose', { mode: snapshot.mode }),
          lifetime.deadline(),
        ),
      ),
    )
    for (const plugin of snapshot.manifest.plugins ?? []) {
      if (!plugin.entry) continue
      const factory = yield* attempt(() =>
        importDefault<PluginFactory>(
          resolve(snapshot.outDir, plugin.entry!.file),
        ),
      )
      if (typeof factory !== 'function')
        return yield* Effect.fail(
          new Error(
            `Neem plugin [${plugin.name}] entry must default-export a plugin factory`,
          ),
        )
      const scope = yield* boundedScope(lifetime, `Plugin [${plugin.name}]`)
      const pluginHooks = yield* Effect.acquireRelease(
        invoke(() =>
          factory({
            name: plugin.name,
            mode: snapshot.mode,
            options: plugin.options,
            logger: snapshot.logger,
            getHealth,
          }),
        ),
        (callbacks) =>
          releaseStep(
            `Plugin [${plugin.name}] disposal`,
            invoke(() => callbacks.dispose?.({ mode: snapshot.mode })),
            lifetime.deadline(),
          ),
      ).pipe(Scope.provide(scope))
      yield* Effect.acquireRelease(
        Effect.sync(() => hooks.addHooks(pluginHooks)),
        (remove) => Effect.sync(remove),
      ).pipe(Scope.provide(scope))
    }
    yield* hooks.call(snapshot.logger, 'initialize', { mode: snapshot.mode })
  }).pipe(Scope.provide(lifetime.scope))
