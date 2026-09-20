import * as Effect from 'effect/Effect'

/** Existing engine scenarios use async bodies; the runtime sees only Effects. */
export const fromPromise = <A>(handler: () => A | Promise<A>) =>
  Effect.promise(() => Promise.resolve(handler()))
