import { IsProcedureContract, IsStreamContract } from '@nmtjs/contract'
import { createLogger } from '@nmtjs/core'
import { t } from '@nmtjs/type'
import { describe, expect, it } from 'vitest'

import {
  createProcedure,
  createRootRouter,
  createRouter,
  createStream,
  defineApplication,
  NeemataApplication,
} from '../src/index.ts'

const logger = createLogger({ pinoOptions: { enabled: false } }, 'test')

function createRuntime(routes: Record<string, any>) {
  const config = defineApplication({
    router: createRootRouter([createRouter({ routes })] as const),
  })
  return new NeemataApplication(config, { logger })
}

describe('route kinds', () => {
  it('creates procedure and stream contracts with distinct kinds', () => {
    const proc = createProcedure({
      input: t.object({ ok: t.boolean() }),
      handler: async (_ctx, input) => input,
    })
    const strm = createStream({
      input: t.object({ ok: t.boolean() }),
      handler: async function* () {
        yield 'ok'
      },
    })

    expect(IsProcedureContract(proc.contract)).toBe(true)
    expect(IsStreamContract(proc.contract)).toBe(false)
    expect(IsStreamContract(strm.contract)).toBe(true)
    expect(IsProcedureContract(strm.contract)).toBe(false)
    expect(proc.contract.type).toBe('neemata:procedure')
    expect(strm.contract.type).toBe('neemata:stream')
  })

  it('threads title and description into the synthesized contract', () => {
    const proc = createProcedure({
      title: 'Ping',
      description: 'Answers with the same payload',
      handler: async () => 'pong',
    })
    const strm = createStream({
      title: 'Ticks',
      description: 'Emits ticks',
      handler: async function* () {
        yield 1
      },
    })

    expect(proc.contract).toHaveProperty('title', 'Ping')
    expect(proc.contract).toHaveProperty(
      'description',
      'Answers with the same payload',
    )
    expect(strm.contract).toHaveProperty('title', 'Ticks')
    expect(strm.contract).toHaveProperty('description', 'Emits ticks')
  })

  it('accepts streamTimeout on stream routes', () => {
    const strm = createStream({
      streamTimeout: 500,
      handler: async function* () {
        yield 1
      },
    })
    expect(strm.streamTimeout).toBe(500)

    expect(() =>
      createStream({
        streamTimeout: -1,
        handler: async function* () {
          yield 1
        },
      }),
    ).toThrow('Stream timeout must be a positive integer')
  })
})

describe('route key charset', () => {
  const okHandler = async () => 'ok'

  it('registers routes with allowed keys', async () => {
    const runtime = createRuntime({
      'valid-Key-123': createProcedure(okHandler),
    })
    await runtime.initialize()
    expect(runtime.procedures.has('valid-Key-123')).toBe(true)
    await runtime.dispose()
  })

  it.each(['users.create', 'users_create', 'users create', 'users/create'])(
    'rejects route key %j at registration',
    async (key) => {
      const runtime = createRuntime({ [key]: createProcedure(okHandler) })
      await expect(runtime.initialize()).rejects.toThrow(
        `Invalid route key "${key}"`,
      )
    },
  )

  it('rejects invalid nested router route keys', async () => {
    const nested = createRouter({
      routes: { 'bad.key': createProcedure(okHandler) },
    })
    const runtime = createRuntime({ nested })
    await expect(runtime.initialize()).rejects.toThrow(
      'Invalid route key "bad.key"',
    )
  })
})
