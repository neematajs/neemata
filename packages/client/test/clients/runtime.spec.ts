import { ClientMessageType, ErrorCode, ProtocolVersion } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/client'
import { describe, expect, it, vi } from 'vitest'

import type { BaseClientOptions } from '../../src/common.ts'
import {
  createRuntimeBidirectionalSetup,
  createRuntimeUnidirectionalClient,
  encodeRpcError,
  encodeRpcResponse,
  TestRuntimeClient,
  toUint8,
} from '../_setup.ts'

describe('Runtime client behaviour', () => {
  describe('Bidirectional transport', () => {
    it('connects through transport and emits lifecycle events', async () => {
      const { client, format, transport, instance, connectParamsRef } =
        createRuntimeBidirectionalSetup()
      const handler = vi.fn()
      client.on('connected', handler)

      await client.connect()
      expect(transport).toHaveBeenCalledWith(
        { format, protocol: ProtocolVersion.v1 },
        undefined,
      )
      expect(instance.connect).toHaveBeenCalled()

      const params = connectParamsRef()!
      await params.onConnect()
      expect(handler).toHaveBeenCalled()
    })

    it('resolves calls when RpcResponse arrives', async () => {
      const { client, format, connectParamsRef, sendMock } =
        createRuntimeBidirectionalSetup()
      await client.connect()
      const params = connectParamsRef()!

      const promise = client.callProcedure('users/list', { take: 1 })
      expect(sendMock).toHaveBeenCalledTimes(1)

      const [callId] = client.pendingCallIds()
      await params.onMessage(encodeRpcResponse(format, callId, { data: 42 }))
      await expect(promise).resolves.toEqual({ data: 42 })
    })

    it('wraps results when safe mode is enabled', async () => {
      const { transport, format, connectParamsRef } =
        createRuntimeBidirectionalSetup()
      const options: BaseClientOptions<any, true> = {
        contract: { routes: {} } as any,
        protocol: ProtocolVersion.v1,
        format,
        safe: true,
      }
      const safeClient = new TestRuntimeClient<true>(
        options,
        transport,
        undefined,
      )

      await safeClient.connect()
      const params = connectParamsRef()!
      const promise = safeClient.callProcedure('users/list')

      const [callId] = safeClient.pendingCallIds()
      await params.onMessage(
        encodeRpcError(format, callId, {
          code: ErrorCode.InternalServerError,
          message: 'boom',
        }),
      )

      await expect(promise).resolves.toEqual({
        error: expect.objectContaining({ code: ErrorCode.InternalServerError }),
      })
    })

    it('sends RpcAbort when a call is cancelled', async () => {
      const { client, sendMock } = createRuntimeBidirectionalSetup()
      await client.connect()

      const controller = new AbortController()
      const promise = client.callProcedure('users/list', {}, controller.signal)
      controller.abort()

      await expect(promise).rejects.toBeInstanceOf(ProtocolError)

      const message = sendMock.mock.calls.at(-1)?.[0] as
        | ArrayBufferView
        | undefined
      expect(message).toBeTruthy()
      expect(toUint8(message!)[0]).toBe(ClientMessageType.RpcAbort)
    })
  })

  describe('Unidirectional transport', () => {
    it('uses transport shortcut', async () => {
      const { client, call, format } = createRuntimeUnidirectionalClient()
      await client.connect()

      const result = await client.callProcedure('status', { ping: true })
      expect(result).toEqual({ ok: true })
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ format }),
        expect.objectContaining({
          procedure: 'status',
          payload: { ping: true },
        }),
        expect.objectContaining({ signal: undefined }),
      )
    })
  })
})
