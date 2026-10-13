import type { WorkflowEngine as Engine } from 'effect/workflow'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schedule from 'effect/Schedule'
import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'
import { WorkflowEngine } from 'effect/workflow'

import type { Definition, Status } from '../../src/native-effect/index.ts'
import { status } from '../../src/native-effect/index.ts'

/** Stands for whatever a schema needs to write or read its stored form. */
export class Codec extends Context.Service<
  Codec,
  { readonly prefix: string }
>()('test/Codec') {}

/** A string stored with the codec's prefix: only writing it needs `Codec`. */
export const StampedOnWrite = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((stored: string) => stored),
    encode: SchemaGetter.transformEffect((value: string) =>
      Codec.pipe(Effect.map(({ prefix }) => prefix + value)),
    ),
  }),
)

/** A string given the codec's prefix when read: only reading needs `Codec`. */
export const StampedOnRead = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transformEffect((stored: string) =>
      Codec.pipe(Effect.map(({ prefix }) => prefix + stored)),
    ),
    encode: SchemaGetter.transform((value: string) => value),
  }),
)

/** Counts how often a named piece of handler code actually ran. */
export function counter() {
  const counts = new Map<string, number>()
  return {
    hit(name: string) {
      return Effect.sync(() => {
        const count = (counts.get(name) ?? 0) + 1
        counts.set(name, count)
        return count
      })
    },
    read(name: string) {
      return counts.get(name) ?? 0
    },
  }
}

/** Runs a scenario against handlers registered on a fresh memory engine. */
export function run<A, E>(
  handlers: Layer.Layer<never, never, Engine.WorkflowEngine>,
  scenario: Effect.Effect<A, E, Engine.WorkflowEngine>,
) {
  const layer = handlers.pipe(Layer.provideMerge(WorkflowEngine.layerMemory))
  return Effect.runPromise(
    scenario.pipe(Effect.provide(layer), Effect.timeout('10 seconds')),
  )
}

export function waitUntil(done: () => boolean) {
  return Effect.sync(done).pipe(
    Effect.repeat({
      until: (ok) => ok,
      schedule: Schedule.spaced('5 millis'),
    }),
  )
}

/** Polls until the execution reaches `tag`, failing the test on a timeout. */
export function waitFor<
  Name extends string,
  Fields extends Schema.Struct.Fields,
  Success extends Schema.Top,
  Error extends Schema.Top,
  const Tag extends Status<unknown, unknown>['_tag'],
>(
  definition: Definition<Name, Fields, Success, Error>,
  executionId: string,
  tag: Tag,
  timeout: Parameters<typeof Effect.timeout>[1] = '5 seconds',
) {
  type Reached = Extract<Status<Success['Type'], Error['Type']>, { _tag: Tag }>

  function reached(
    current: Status<Success['Type'], Error['Type']>,
  ): current is Reached {
    return current._tag === tag
  }

  return Effect.gen(function* () {
    while (true) {
      const current = yield* status(definition, executionId)
      if (reached(current)) return current
      yield* Effect.sleep('5 millis')
    }
  }).pipe(Effect.timeout(timeout))
}
