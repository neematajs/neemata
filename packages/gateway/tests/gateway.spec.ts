import {
  createFactoryInjectable,
  createValueInjectable,
  Hooks,
  Scope,
} from '@nmtjs/core'
import { createProtocolBlobReference } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import type { GatewayApi } from '../src/api.ts'
import type { TransportWorkerParams } from '../src/transport.ts'
import type { ConnectionIdentity } from '../src/types.ts'
import { Gateway, gatewayLoggerOptions } from '../src/gateway.ts'
import { createTestContainer, createTestLogger } from './_helpers/test-utils.ts'

describe('Gateway logger payload serializer', () => {
  it('renders blob placeholders instead of traversing them as objects', () => {
    const serialize = gatewayLoggerOptions.serializers!.payload
    const blob = createProtocolBlobReference(1, { size: 3, type: 'text/plain' })

    const result = serialize({
      file: blob,
      list: [blob],
      nested: { value: 42 },
    })

    const placeholder = `<ClientBlobStream metadata=${JSON.stringify(blob.metadata)}>`
    expect(result.file).toBe(placeholder)
    expect(result.list).toStrictEqual([placeholder])
    expect(result.nested).toStrictEqual({ value: 42 })
  })
})

describe('Gateway reload', () => {
  it('rebinds live connection scopes to the replacement application', async () => {
    const identity = createValueInjectable('old')
    const setup = createReloadableGateway(identity)
    await setup.gateway.start()
    const connection = await setup.params().onConnect({ data: { id: 1 } })
    const previousContainer = connection.container
    const nextIdentity = createValueInjectable('new')

    await setup.gateway.reload({
      ...setup.gateway.options,
      container: setup.nextContainer,
      identity: nextIdentity,
    })

    expect(connection.container).not.toBe(previousContainer)
    expect(connection.container.find(Scope.Global)).toBe(setup.nextContainer)
    expect(connection.identity).toBe('new')

    await connection[Symbol.asyncDispose]()
    await setup.gateway.stop()
    await setup.dispose()
  })

  it('retries a connection created while reload is in progress', async () => {
    let identityStarted!: () => void
    let releaseIdentity!: () => void
    const started = new Promise<void>((resolve) => {
      identityStarted = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseIdentity = resolve
    })
    const identity = createFactoryInjectable({
      async create() {
        identityStarted()
        await release
        return 'old'
      },
    })
    const setup = createReloadableGateway(identity)
    await setup.gateway.start()

    const connecting = setup.params().onConnect({ data: {} })
    await started
    await setup.gateway.reload({
      ...setup.gateway.options,
      container: setup.nextContainer,
      identity: createValueInjectable('new'),
    })
    releaseIdentity()
    const connection = await connecting

    expect(connection.identity).toBe('new')
    expect(connection.container.find(Scope.Global)).toBe(setup.nextContainer)

    await connection[Symbol.asyncDispose]()
    await setup.gateway.stop()
    await setup.dispose()
  })

  it('aborts and drains active calls before disposing old scopes', async () => {
    let finishCall!: () => void
    let observedAbort!: () => void
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve
    })
    const setup = createReloadableGateway(
      createValueInjectable('identity'),
      async ({ signal }) => {
        signal.addEventListener('abort', observedAbort, { once: true })
        await new Promise<void>((resolve) => {
          finishCall = resolve
        })
      },
    )
    await setup.gateway.start()
    const connection = await setup.params().onConnect({ data: {} })
    const previousContainer = connection.container
    const rpc = setup
      .params()
      .onRpc(
        connection,
        { procedure: 'test', payload: {} },
        new AbortController().signal,
      )

    let reloaded = false
    const reload = setup.gateway
      .reload({
        ...setup.gateway.options,
        container: setup.nextContainer,
      })
      .then(() => {
        reloaded = true
      })
    await aborted
    expect(reloaded).toBe(false)
    expect(connection.container).toBe(previousContainer)

    finishCall()
    await Promise.all([rpc, reload])
    expect(connection.container).not.toBe(previousContainer)

    await connection[Symbol.asyncDispose]()
    await setup.gateway.stop()
    await setup.dispose()
  })
})

function createReloadableGateway(
  identity: ConnectionIdentity,
  call: GatewayApi['call'] = async () => undefined,
) {
  const logger = createTestLogger()
  const container = createTestContainer({ logger })
  const nextContainer = createTestContainer({ logger })
  const api = {
    resolve: vi.fn(async () => ({ name: 'test', stream: false })),
    call: vi.fn(call),
  }
  let params: TransportWorkerParams | undefined
  const gateway = new Gateway({
    logger,
    container,
    hooks: new Hooks(),
    transports: {
      test: {
        transport: {
          async start(next) {
            params = next
            return 'test://'
          },
          async stop() {},
        },
      },
    },
    api,
    identity,
  })

  return {
    gateway,
    nextContainer,
    params: () => params!,
    async dispose() {
      await Promise.all([container.dispose(), nextContainer.dispose()])
    },
  }
}
