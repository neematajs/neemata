import type { Logger } from 'pino'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'

import type {
  NeemHostHookMap as HostHookMap,
  NeemPluginHooks,
} from '../shared/types.ts'
import { attempt, causeErrors } from './lifetime.ts'
import { normalizeError, throwCollected } from './utils.ts'

type Callback = (...args: any[]) => unknown
export type PluginHooks = NeemPluginHooks

/** Ordered lifecycle commands: unlike notifications, their callers await completion. */
export class HostHooks {
  private readonly callbacks = new Map<keyof HostHookMap, Callback[]>()

  hook<K extends keyof HostHookMap>(
    name: K,
    callback: NonNullable<PluginHooks[K]>,
  ): () => void {
    const list = this.callbacks.get(name) ?? []
    list.push(callback)
    this.callbacks.set(name, list)
    return () => {
      const index = list.indexOf(callback)
      if (index >= 0) list.splice(index, 1)
    }
  }

  addHooks(hooks: PluginHooks): () => void {
    const removers = Object.entries(hooks).map(([name, callback]) =>
      this.hook(name as keyof HostHookMap, callback),
    )
    return () => {
      for (const remove of removers) remove()
    }
  }

  call<K extends keyof HostHookMap>(
    logger: Logger,
    name: K,
    ...args: Parameters<HostHookMap[K]>
  ): Effect.Effect<void, Error> {
    return Effect.gen({ self: this }, function* () {
      const callbacks: Callback[] = []
      callbacks.push(...(this.callbacks.get(name) ?? []))
      logger.trace(
        { hook: name, callbacks: callbacks.length },
        'Neem host hook callbacks',
      )
      const errors: Error[] = []
      for (const callback of callbacks) {
        const exit = yield* Effect.exit(invoke(() => callback(...args)))
        if (Exit.isFailure(exit)) {
          if (exit.cause.reasons.some((reason) => reason._tag === 'Interrupt'))
            return yield* Effect.failCause(exit.cause)
          errors.push(...causeErrors(exit.cause))
        }
      }
      yield* Effect.try({
        try: () => throwCollected(errors, `Neem hook [${name}] failed`),
        catch: normalizeError,
      })
    })
  }
}

export const createHostHooks = () => new HostHooks()

export const invoke = <A, R = never>(
  callback: () => A | PromiseLike<A> | Effect.Effect<A, Error, R>,
): Effect.Effect<A, Error, R> =>
  Effect.try({ try: callback, catch: normalizeError }).pipe(
    Effect.flatMap((value) =>
      Effect.isEffect(value) ? value : attempt(() => value),
    ),
  )
