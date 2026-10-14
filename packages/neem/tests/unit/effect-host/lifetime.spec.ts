import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Scope from 'effect/Scope'
import { describe, expect, it } from 'vitest'

import {
  boundedScope,
  closeWithin,
  Deadline,
  Lifetime,
  releaseStep,
} from '../../../src/internal/lifetime.ts'

describe('Lifetime', () => {
  it('releases a resource acquired after its lifetime closed', async () => {
    const lifetime = Lifetime.make(1_000)
    const acquired = Deferred.makeUnsafe<void>()
    const released: string[] = []

    const acquiring = Effect.runFork(
      Effect.acquireRelease(
        Deferred.await(acquired).pipe(Effect.as('late')),
        (resource) => Effect.sync(() => released.push(resource)),
      ).pipe(Scope.provide(lifetime.scope)),
    )
    await Effect.runPromise(lifetime.close(Deadline.after(1_000)))
    expect(released).toEqual([])

    Deferred.doneUnsafe(acquired, Effect.void)
    await Effect.runPromise(Fiber.await(acquiring))
    expect(released).toEqual(['late'])
  })

  it('gives finalizers of a child closed through its parent the parent deadline', async () => {
    const parent = Lifetime.make(60_000)
    const child = parent.fork()
    const seen: number[] = []
    await Effect.runPromise(
      Scope.addFinalizer(
        child.scope,
        Effect.sync(() => seen.push(child.deadline().at)),
      ),
    )

    const deadline = Deadline.after(250)
    await Effect.runPromise(parent.close(deadline))
    // A second close cannot move the deadline its finalizers already spent.
    await Effect.runPromise(parent.close(Deadline.after(5_000)))
    expect(seen).toEqual([deadline.at])
  })

  it('reports every failed release step while the remaining ones still run', async () => {
    const lifetime = Lifetime.make(1_000)
    const ran: string[] = []
    const step = (name: string, effect: Effect.Effect<void, Error>) =>
      Scope.addFinalizer(
        lifetime.scope,
        releaseStep(
          name,
          effect.pipe(Effect.tap(() => Effect.sync(() => ran.push(name)))),
          lifetime.deadline(),
        ),
      )
    await Effect.runPromise(
      Effect.all([
        step('first', Effect.void),
        step('hanging', Effect.never),
        step('failing', Effect.fail(new Error('dispose failed'))),
      ]),
    )

    const errors = await Effect.runPromise(lifetime.close(Deadline.after(100)))
    expect(errors.map((error) => error.message)).toEqual([
      'dispose failed',
      'hanging did not finish within the stop budget',
    ])
    expect(ran).toEqual(['first'])
  })

  it('continues sibling cleanup when an owned plugin finalizer hangs', async () => {
    const lifetime = Lifetime.make(1000)
    const finish = Deferred.makeUnsafe<void>()
    let siblingReleased = false
    await Effect.runPromise(
      Scope.addFinalizer(
        lifetime.scope,
        Effect.sync(() => {
          siblingReleased = true
        }),
      ),
    )
    const plugin = await Effect.runPromise(boundedScope(lifetime, 'Plugin'))
    await Effect.runPromise(Scope.addFinalizer(plugin, Deferred.await(finish)))
    try {
      const errors = await Effect.runPromise(lifetime.close(Deadline.after(50)))
      expect(errors).toHaveLength(1)
      expect(errors[0]).toMatchObject({
        errors: [
          expect.objectContaining({
            message: 'Plugin did not finish within the stop budget',
          }),
        ],
      })
      expect(siblingReleased).toBe(true)
    } finally {
      Deferred.doneUnsafe(finish, Effect.void)
    }
  }, 1000)

  it('stops waiting for an uninterruptible close at the deadline', async () => {
    const scope = Scope.makeUnsafe()
    const finish = Deferred.makeUnsafe<void>()
    await Effect.runPromise(Scope.addFinalizer(scope, Deferred.await(finish)))

    const startedAt = Date.now()
    const errors = await Effect.runPromise(
      closeWithin('Release', scope, Deadline.after(100)),
    )
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(errors.map((error) => error.message)).toEqual([
      'Release did not finish within the stop budget',
    ])
    Deferred.doneUnsafe(finish, Effect.void)
  })
})
