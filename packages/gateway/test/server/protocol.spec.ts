import type { AnyInjectable } from '@nmtjs/core'
import type { Mock } from 'vitest'
import {
  Container,
  createHook,
  createLazyInjectable,
  Hooks,
  Registry,
  Scope,
} from '@nmtjs/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ProtocolApiCallOptions,
  ProtocolApiCallResult,
} from '../../src/api.ts'
import { ServerMessageType } from '../../src/common/enums.ts'
import { Connection, ConnectionContext } from '../../src/connection.ts'
import { ProtocolHook } from '../../src/enums.ts'
import { ProtocolInjectables } from '../../src/injectables.ts'
import { ProtocolFormat } from '../../src/server/format.ts'
import { Protocol } from '../../src/server/protocol.ts'
import {
  UnsupportedAcceptTypeError,
  UnsupportedContentTypeError,
} from '../../src/utils.ts'
import { testFormat, testLogger } from '../_utils.ts'

type CallSpy = Mock<
  (args: ProtocolApiCallOptions) => Promise<ProtocolApiCallResult>
>

describe('Server Protocol', () => {
  const dummyTransport = { send: vi.fn() }
  const api: { call: CallSpy } = { call: vi.fn() }
  const logger = testLogger()

  const format = testFormat()
  const defaultInjectablesNumbers = new Container({
    registry: new Registry({ logger }),
    logger,
  }).instances.size
  let registry: Registry
  let container: Container
  let protocol: Protocol

  beforeEach(() => {
    api.call = vi.fn()
    registry = new Registry({ logger })
    container = new Container({ logger, registry })
    protocol = new Protocol(
      {
        hooks: new Hooks({ registry, container }),
        api,
        container,
        registry,
        logger,
      },
      { formats: [format] },
    )
  })

  it('should be created', () => {
    expect(protocol).toBeInstanceOf(Protocol)
  })

  it('should handle a call', async () => {
    api.call = vi.fn(async (options) => {
      return { output: options }
    })
    const connectionId = '1'
    const connectionData = {}
    const payload = {}
    const procedure = 'test'
    const ac = new AbortController()
    const validateMetadata = vi.fn()
    const connection = new Connection({
      id: connectionId,
      data: connectionData,
    })
    const callContainer = container.fork(Scope.Call)
    callContainer.provide(ProtocolInjectables.connectionData, connectionData)
    const callOptions = {
      connection,
      container: callContainer,
      procedure,
      payload,
      signal: ac.signal,
      validateMetadata,
    }
    await expect(
      callContainer.resolve(ProtocolInjectables.connectionData),
    ).resolves.toBe(connectionData)

    const result = await protocol.call(callOptions)
    expect(callContainer.instances.size).toBe(defaultInjectablesNumbers + 1)
    expect(result).toHaveProperty('output')
    expect(result.output).toMatchObject(callOptions)
  })

  describe('Connections', () => {
    it('should succeed to add and initialize a connection', async () => {
      const connectionId = '1'
      const connectionData = {}

      const onConnectionHook = createHook({
        name: ProtocolHook.Connect,
        handler: vi.fn(),
      })

      registry.registerHook(onConnectionHook)

      const { connection, context } = await protocol.addConnection(
        dummyTransport,
        { id: connectionId, data: connectionData },
        { acceptType: format.contentType, contentType: format.contentType },
      )

      expect(connection).toBeInstanceOf(Connection)
      expect(connection.id).toBe(connectionId)
      expect(connection.data).toBe(connectionData)
      expect(context).toBeInstanceOf(ConnectionContext)
      expect(context.container).toBeInstanceOf(Container)
      expect(context.rpcs).toBeInstanceOf(Map)
      expect(context.clientStreams).toBeInstanceOf(Map)
      expect(context.serverStreams).toBeInstanceOf(Map)
      expect(context.rpcStreams).toBeInstanceOf(Map)
      expect(context.streamId).toBe(1)
      expect(context.format).toHaveProperty('encoder')
      expect(context.format).toHaveProperty('decoder')

      // to call OnConnect hooks
      expect(onConnectionHook.handler).toHaveBeenCalledOnce()
    })

    it('should succeed to get a connection', async () => {
      const connectionId = '1'
      const connectionData = {}
      const added = await protocol.addConnection(
        dummyTransport,
        { id: connectionId, data: connectionData },
        { acceptType: format.contentType, contentType: format.contentType },
      )

      const connection = protocol.getConnection(connectionId)
      expect(connection).toHaveProperty('connection', added.connection)
      expect(connection).toHaveProperty('context', added.context)
    })

    it('should fail to get a connection', async () => {
      expect(() => protocol.getConnection('')).toThrow()
    })

    it('should succeed to remove a connection', async () => {
      const connectionId = '1'
      const connectionData = {}
      const onDisconnectionHook = createHook({
        name: ProtocolHook.Disconnect,
        handler: vi.fn(),
      })

      registry.registerHook(onDisconnectionHook)

      await protocol.addConnection(
        dummyTransport,
        { id: connectionId, data: connectionData },
        { acceptType: format.contentType, contentType: format.contentType },
      )

      await expect(
        protocol.removeConnection(connectionId),
      ).resolves.not.toThrow()
      expect(onDisconnectionHook.handler).toHaveBeenCalledOnce()
    })

    it('should fail to a connection with unsupported format', async () => {
      const connectionId = '1'
      const connectionData = {}

      await expect(
        protocol.addConnection(
          dummyTransport,
          { id: connectionId, data: connectionData },
          { acceptType: 'unknown/unknown', contentType: format.contentType },
        ),
      ).rejects.toThrowError(UnsupportedAcceptTypeError)

      await expect(
        protocol.addConnection(
          dummyTransport,
          { id: connectionId, data: connectionData },
          { acceptType: format.contentType, contentType: 'unknown/unknown' },
        ),
      ).rejects.toThrowError(UnsupportedContentTypeError)
    })
  })

  describe('RPC', () => {
    let connection: Connection
    let context: ConnectionContext
    const connectionId = '1'
    const connectionData = {}

    beforeEach(async () => {
      const added = await protocol.addConnection(
        dummyTransport,
        { id: connectionId, data: connectionData },
        { acceptType: format.contentType, contentType: format.contentType },
      )
      connection = added.connection
      context = added.context
    })

    it('should succeed to add a plain RPC', async () => {
      api.call = vi.fn(async (options) => {
        return { output: options.payload }
      })

      const callId = 1
      const payload = {}
      const procedure = 'test'
      const validateMetadata = vi.fn()
      const ac = new AbortController()
      const testInjectable = createLazyInjectable<{}>()
      const provides: [AnyInjectable, any][] = [[testInjectable, {}]]

      const result = protocol.rpc(
        connectionId,
        { callId, payload, procedure },
        { validateMetadata, signal: ac.signal, provides },
      )

      expect(context.rpcs.get(callId)).toBeInstanceOf(AbortController)
      expect(context.clientStreams.size).toBe(0)
      expect(context.serverStreams.size).toBe(0)
      expect(context.rpcStreams.size).toBe(0)
      expect(context.streamId).toBe(1)

      await expect(result).resolves.not.toThrow()

      // should clean up the call
      expect(context.rpcs.get(callId)).toBeUndefined()

      const apiCallOptions = api.call.mock.calls[0][0]
      const apiCallResult = await api.call.mock.results[0].value

      expect(apiCallOptions).toEqual({
        connection,
        container: expect.any(Container),
        procedure,
        payload,
        signal: expect.any(AbortSignal),
        validateMetadata,
      })

      // should fork a new container with Call scope
      expect(apiCallOptions.container).not.toBe(context.container)
      expect(apiCallOptions.container.scope).toBe(Scope.Call)

      const expectedBuffer = context.format.encoder.encodeRPC(
        { callId, result: apiCallResult.output },
        // @ts-expect-error
        { addStream() {}, getStream() {} },
      )

      // should send the response via provided transport
      const transportSendArguments = dummyTransport.send.mock.calls[0]
      expect(transportSendArguments[0]).toBe(connection)
      expect(transportSendArguments[1]).toBe(ServerMessageType.RpcResponse)
      expect(transportSendArguments[2]).toStrictEqual(expectedBuffer)
      expect(transportSendArguments[3]).toBeDefined()
    })
  })
})
