import * as Effect from 'effect/Effect'
import * as FiberSet from 'effect/FiberSet'
import * as Scope from 'effect/Scope'

import { boundedScope, type Lifetime } from './lifetime.ts'

/** Owned callback fibers inherit services without letting stuck work hold shutdown open. */
export const callbackRunner = (lifetime: Lifetime) =>
  Effect.gen(function* () {
    const scope = yield* boundedScope(lifetime, 'Background tasks')
    return yield* FiberSet.makeRuntime<never, void, never>().pipe(
      Scope.provide(scope),
    )
  })
