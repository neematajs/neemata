import * as Effect from 'effect/Effect'

import { definePluginHooks } from '../../../../src/public/index.ts'

export default definePluginHooks(({ options }) =>
  Effect.gen(function* () {
    const { key } = options as { key: string }
    const events = Reflect.get(globalThis, key) as string[]
    yield* Effect.acquireRelease(
      Effect.sync(() => events.push('acquire')),
      () =>
        Effect.sync(() => {
          events.push('release')
        }),
    )
    return {
      dispose: () =>
        Effect.sync(() => {
          events.push('dispose')
        }),
    }
  }),
)
