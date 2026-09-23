import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { expect, it } from 'vitest'

import { defineEffectWorker } from '../../src/neem/worker.ts'

class Missing extends Context.Service<Missing, string>()('Missing') {}
class LayerError extends Error {
  readonly _tag = 'LayerError'
}
class MainError extends Error {
  readonly _tag = 'MainError'
}

it('infers independent layer and main errors', () => {
  const worker = defineEffectWorker(() => ({
    layer: Layer.effect(Missing)(Effect.fail(new LayerError())),
    main: () => Effect.fail(new MainError()),
  }))
  expect(worker).toBeDefined()
})

it('requires the layer to provide every service consumed by main', () => {
  const missing = Effect.gen(function* () {
    yield* Missing
  })
  const worker = defineEffectWorker(() => ({
    layer: Layer.succeed(Missing)('provided'),
    main: () =>
      Effect.gen(function* () {
        yield* Missing
      }),
  }))
  expect(worker).toBeDefined()

  defineEffectWorker(() => ({
    layer: Layer.empty,
    // @ts-expect-error The application's layer does not provide Missing.
    main: () => missing,
  }))

  defineEffectWorker(() => ({
    // @ts-expect-error The application layer must not require external services.
    layer: Layer.effectDiscard(Missing),
    main: () => Effect.void,
  }))
})
