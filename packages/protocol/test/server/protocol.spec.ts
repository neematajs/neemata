import {
  type AnyInjectable,
  Container,
  createLazyInjectable,
  Hook,
  type Logger,
  Registry,
  Scope,
} from '@nmtjs/core'
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest'
import { testLogger } from '../../../core/test/_utils.ts'
import { ServerMessageType } from '../../src/common/enums.ts'
import type {
  ProtocolApiCallOptions,
  ProtocolApiCallResult,
} from '../../src/server/api.ts'
import { Connection, ConnectionContext } from '../../src/server/connection.ts'
import { Format } from '../../src/server/format.ts'
import { ProtocolInjectables } from '../../src/server/injectables.ts'
import { Protocol } from '../../src/server/protocol.ts'
import {
  UnsupportedAcceptTypeError,
  UnsupportedContentTypeError,
} from '../../src/server/utils.ts'
import { testFormat } from '../mixtures.ts'

type CallSpy = Mock<
  (args: ProtocolApiCallOptions) => Promise<ProtocolApiCallResult>
>

describe('Server Protocol', () => {
  const dummyTransport = { send: vi.fn() }
  const api: { call: CallSpy } = { call: vi.fn() }
  let registry: Registry
  let logger: Logger
  let container: Container
  let protocol: Protocol
  const format = testFormat()

  beforeEach(() => {
    api.call = vi.fn()
    logger = testLogger()
    registry = new Registry({ logger })
    container = new Container({
      logger,
      registry,
    })
    protocol = new Protocol({
      api,
      container,
      registry,
      logger,
      format: new Format([format]),
    })
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
    const namespace = 'test'
    const procedure = 'test'
    const ac = new AbortController()
    const metadata = vi.fn()
    const connection = new Connection({
      id: connectionId,
      data: connectionData,
    })
    const callContainer = container.fork(Scope.Call)
    callContainer.provide(ProtocolInjectables.connectionData, connectionData)
    const callOptions = {
      connection,
      container: callContainer,
      namespace,
      procedure,
      payload,
      signal: ac.signal,
      metadata,
    }
    await expect(
      callContainer.resolve(ProtocolInjectables.connectionData),
    ).resolves.toBe(connectionData)

    const result = await protocol.call(callOptions)

    expect(result).toHaveProperty('output')
    expect(result.output).toMatchObject(callOptions)

    // container should be disposed
    await expect(
      callContainer.resolve(ProtocolInjectables.connectionData),
    ).rejects.toThrow()
  })

  describe('Connections', () => {
    it('should succeed to add and initialize a connection', async () => {
      const connectionId = '1'
      const connectionData = {}

      const onConnectionHook = vi.fn()

      registry.registerHook(Hook.OnConnect, onConnectionHook)

      const { connection, context } = await protocol.addConnection(
        dummyTransport,
        {
          id: connectionId,
          data: connectionData,
        },
        { acceptType: format.contentType, contentType: format.contentType },
      )

      expect(connection).toBeInstanceOf(Connection)
      expect(connection.id).toBe(connectionId)
      expect(connection.data).toBe(connectionData)
      expect(context).toBeInstanceOf(ConnectionContext)
      expect(context.container).toBeInstanceOf(Container)
      expect(context.calls).toBeInstanceOf(Map)
      expect(context.clientStreams).toBeInstanceOf(Map)
      expect(context.serverStreams).toBeInstanceOf(Map)
      expect(context.rpcStreams).toBeInstanceOf(Map)
      expect(context.streamId).toBe(1)
      expect(context.format).toHaveProperty('encoder')
      expect(context.format).toHaveProperty('decoder')

      // to call OnConnect hooks
      expect(onConnectionHook).toHaveBeenCalledOnce()
    })

    it('should succeed to get a connection', async () => {
      const connectionId = '1'
      const connectionData = {}
      const added = await protocol.addConnection(
        dummyTransport,
        {
          id: connectionId,
          data: connectionData,
        },
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
      const onDisconnectionHook = vi.fn()

      registry.registerHook(Hook.OnDisconnect, onDisconnectionHook)

      await protocol.addConnection(
        dummyTransport,
        {
          id: connectionId,
          data: connectionData,
        },
        { acceptType: format.contentType, contentType: format.contentType },
      )

      await expect(
        protocol.removeConnection(connectionId),
      ).resolves.not.toThrow()
      expect(onDisconnectionHook).toHaveBeenCalledOnce()
    })

    it('should fail to a connection with unsupported format', async () => {
      const connectionId = '1'
      const connectionData = {}

      await expect(
        protocol.addConnection(
          dummyTransport,
          {
            id: connectionId,
            data: connectionData,
          },
          { acceptType: 'unknown/unknown', contentType: format.contentType },
        ),
      ).rejects.toThrowError(UnsupportedAcceptTypeError)

      await expect(
        protocol.addConnection(
          dummyTransport,
          {
            id: connectionId,
            data: connectionData,
          },
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
        {
          id: connectionId,
          data: connectionData,
        },
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
      const namespace = 'test'
      const procedure = 'test'
      const metadata = vi.fn()
      const ac = new AbortController()
      const testInjectable = createLazyInjectable<{}>()
      const provides: [AnyInjectable, any][] = [[testInjectable, {}]]

      const result = protocol.rpc(
        connectionId,
        {
          callId,
          payload,
          namespace,
          procedure,
        },
        { metadata, signal: ac.signal, provides },
      )

      expect(context.calls.get(callId)).toBeInstanceOf(AbortController)
      expect(context.clientStreams.size).toBe(0)
      expect(context.serverStreams.size).toBe(0)
      expect(context.rpcStreams.size).toBe(0)
      expect(context.streamId).toBe(1)

      await expect(result).resolves.not.toThrow()

      // should clean up the call
      expect(context.calls.get(callId)).toBeUndefined()

      const apiCallOptions = api.call.mock.calls[0][0]
      const apiCallResult = await api.call.mock.results[0].value

      expect(apiCallOptions).toEqual({
        connection,
        container: expect.any(Container),
        namespace,
        procedure,
        payload,
        signal: expect.any(AbortSignal),
        metadata,
      })

      // should fork a new container with Call scope
      expect(apiCallOptions.container).not.toBe(context.container)
      expect(apiCallOptions.container.scope).toBe(Scope.Call)

      const expectedBuffer = context.format.encoder.encodeRPC(
        {
          callId,
          result: apiCallResult.output,
        },
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
