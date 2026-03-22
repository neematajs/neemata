import { describe, expectTypeOf, it } from 'vitest'

import { n, t } from '../src/index.ts'

describe('guards types', () => {
  it('exposes typed guard factories on the public API', () => {
    const typedGuard = n.guardFactory<{ enabled: boolean }>()((_ctx, call) => {
      expectTypeOf(call.payload.enabled).toEqualTypeOf<boolean>()
      return call.payload.enabled
    })

    n.procedure({
      input: t.object({ enabled: t.boolean() }),
      guards: [typedGuard],
      handler: async () => ({}),
    })
  })

  it('infers decoded payload types for procedure guards', () => {
    const typedGuard = n.guardFactory<{ createdAt: Date; slug: string }>()(
      (_ctx, call) => {
        expectTypeOf(call.payload.createdAt).toEqualTypeOf<Date>()
        expectTypeOf(call.payload.slug).toEqualTypeOf<string>()
        return true
      },
    )

    n.procedure({
      input: t.object({ createdAt: t.date(), slug: t.string() }),
      guards: [typedGuard],
      handler: async () => ({}),
    })
  })

  it('infers flattened unions for nested router guards', () => {
    const typedGuard = n.guardFactory<
      { createdAt: Date; slug: string } | { retries: number; active: boolean }
    >()((_ctx, call) => {
      expectTypeOf(call.payload).toEqualTypeOf<
        { createdAt: Date; slug: string } | { retries: number; active: boolean }
      >()
      return true
    })

    n.router({
      routes: {
        first: n.procedure({
          input: t.object({ createdAt: t.date(), slug: t.string() }),
          handler: async () => ({}),
        }),
        nested: n.router({
          routes: {
            second: n.procedure({
              input: t.object({ retries: t.number(), active: t.boolean() }),
              handler: async () => ({}),
            }),
          },
        }),
      },
      guards: [typedGuard],
    })
  })

  it('rejects procedure guards with incompatible payload types', () => {
    const incompatibleGuard = n.guardFactory<{ createdAt: string }>()(
      () => true,
    )

    n.procedure({
      input: t.object({ createdAt: t.date() }),
      // @ts-expect-error: procedure guard payload must match decoded input
      guards: [incompatibleGuard],
      handler: async () => ({}),
    })
  })

  it('rejects router guards that do not handle every route payload', () => {
    const incompatibleGuard = n.guardFactory<{
      createdAt: Date
      slug: string
    }>()(() => true)

    n.router({
      routes: {
        first: n.procedure({
          input: t.object({ createdAt: t.date(), slug: t.string() }),
          handler: async () => ({}),
        }),
        nested: n.router({
          routes: {
            second: n.procedure({
              input: t.object({ retries: t.number(), active: t.boolean() }),
              handler: async () => ({}),
            }),
          },
        }),
      },
      // @ts-expect-error: router guard must accept the union of all route inputs
      guards: [incompatibleGuard],
    })
  })
})
