import { c } from '@nmtjs/contract'
import { createLogger, createValueInjectable, Scope } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  createGuard,
  defineApplication,
  implement,
  isProcedure,
  isRootRouter,
  isRouter,
  NeemataApplication,
} from '../src/index.ts'

describe('contract implementation helper', () => {
  const contract = c.router({
    routes: {
      users: c.router({
        routes: {
          list: c.procedure({
            input: t.object({ id: t.string() }),
            output: t.object({ id: t.string() }),
          }),
        },
      }),
      health: c.procedure({ output: t.object({ ok: t.boolean() }) }),
    },
  })

  it('implements a nested router contract with callable route builders', async () => {
    const api = implement(contract)
    const prefix = createValueInjectable<string>('user')
    const allow = createValueInjectable<boolean>(true)
    const router = api({
      users: api.users(
        {
          list: api.users.list({
            dependencies: { prefix },
            handler: (ctx, input) => {
              expectTypeOf(ctx.prefix).toEqualTypeOf<string>()
              expect(ctx.prefix).toBe('user')
              expectTypeOf(input.id).toEqualTypeOf<string>()
              return { id: `${ctx.prefix}:${input.id}` }
            },
          }),
        },
        {
          guards: [
            createGuard({
              dependencies: { allow },
              can: (ctx) => {
                expectTypeOf(ctx.allow).toEqualTypeOf<boolean>()
                return ctx.allow
              },
            }),
          ],
        },
      ),
      health: api.health((_ctx, input) => {
        expectTypeOf(input).toEqualTypeOf<never>()
        return { ok: true }
      }),
    })

    expect(isRootRouter(router)).toBe(true)
    expect(isRouter(router.routes.users)).toBe(true)
    expect(isProcedure(router.routes.health)).toBe(true)
    expect(isProcedure(router.routes.users.routes.list)).toBe(true)
    expect(router.contract).toBe(contract)
    expect(router.routes.users.contract).toBe(contract.routes.users)
    expect(router.routes.users.routes.list.contract).toBe(
      contract.routes.users.routes.list,
    )
    expect(router.routes.users.guards).toHaveLength(1)

    const runtime = new NeemataApplication(defineApplication({ router }), {
      logger: createLogger({ pinoOptions: { enabled: false } }, 'test'),
    })
    try {
      await runtime.initialize()
      expect(runtime.procedures.has('health')).toBe(true)
      expect(runtime.procedures.has('users/list')).toBe(true)

      const callContainer = runtime.container.fork(Scope.Call)
      try {
        await expect(
          runtime.api.call({
            connection: { id: 'connection-1' } as any,
            container: callContainer,
            payload: { id: '1' },
            procedure: 'users/list',
            signal: new AbortController().signal,
          }),
        ).resolves.toEqual({ id: 'user:1' })
      } finally {
        await callContainer.dispose()
      }
    } finally {
      await runtime.dispose()
    }
  })

  it('supports shorthand handlers', async () => {
    const api = implement(contract)
    const router = api({
      users: api.users({
        list: api.users.list((_ctx, input) => {
          expectTypeOf(input.id).toEqualTypeOf<string>()
          return { id: input.id }
        }),
      }),
      health: api.health(() => ({ ok: true })),
    })

    expect(isRootRouter(router)).toBe(true)
    expect(isRouter(router.routes.users)).toBe(true)
    expect(isProcedure(router.routes.health)).toBe(true)
    expect(isProcedure(router.routes.users.routes.list)).toBe(true)
    expect(router.contract).toBe(contract)
    expect(router.routes.users.contract).toBe(contract.routes.users)
    expect(router.routes.users.routes.list.contract).toBe(
      contract.routes.users.routes.list,
    )
    expect(router.routes.users.guards).toHaveLength(0)
  })

  it('rejects missing, extra, and wrong route implementations', () => {
    const api = implement(contract)
    const health = api.health(() => ({ ok: true }))
    const users = api.users({
      list: api.users.list((_ctx, input) => ({ id: input.id })),
    })

    expect(() => api({ users } as any)).toThrow(
      'Missing implementation for route [health]',
    )
    expect(() => api({ users, health, extra: health } as any)).toThrow(
      'Unknown implementation route [extra]',
    )
    expect(() => api({ users: health, health } as any)).toThrow(
      'Implementation for route [users] does not match contract',
    )
  })

  it('handles route names that overlap function and object prototypes', () => {
    const prototypeContract = c.router({
      routes: {
        call: c.procedure({ output: t.string() }),
        bind: c.procedure({ output: t.string() }),
        toString: c.procedure({ output: t.string() }),
        prototype: c.procedure({ output: t.string() }),
      },
    })
    const api = implement(prototypeContract)

    const router = api({
      call: api.call(() => 'call'),
      bind: api.bind(() => 'bind'),
      toString: api.toString(() => 'toString'),
      prototype: api.prototype(() => 'prototype'),
    })

    expect(router.routes.call.contract).toBe(prototypeContract.routes.call)
    expect(router.routes.bind.contract).toBe(prototypeContract.routes.bind)
    expect(router.routes.toString.contract).toBe(
      prototypeContract.routes.toString,
    )
    expect(router.routes.prototype.contract).toBe(
      prototypeContract.routes.prototype,
    )
  })

  it('treats inherited object properties as missing implementations', () => {
    const prototypeContract = c.router({
      routes: { toString: c.procedure({ output: t.string() }) },
    })
    const api = implement(prototypeContract)

    expect(() => api({} as any)).toThrow(
      'Missing implementation for route [toString]',
    )
  })
})
