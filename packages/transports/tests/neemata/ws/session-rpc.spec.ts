import { ServerMessageType } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import {
  createEngineHarness,
  encodeRpcAbort,
  encodeRpcMessage,
} from './_helpers/engine.ts'

const decodeRpcResponse = (message: { id: number; rest: Buffer }) => ({
  callId: message.id,
  isError: message.rest.readUInt8(0) === 1,
  payload: JSON.parse(message.rest.subarray(1).toString('utf-8')),
})

async function createHarness() {
  // each api.call stays in flight until its future is resolved by the test
  const calls: PromiseWithResolvers<unknown>[] = []
  const call = vi.fn(() => {
    const future = Promise.withResolvers<unknown>()
    calls.push(future)
    return future.promise
  })
  const harness = await createEngineHarness({ call })
  return { ...harness, call, calls }
}

describe('WS session RPC handling', () => {
  it('drops a duplicate callId without disturbing the in-flight call', async () => {
    const { engine, call, calls, sent, sentOfType, connection, send, stop } =
      await createHarness()

    // First call stays in flight (api.call promise unresolved)
    const inFlight = send(encodeRpcMessage(1, 'test', {}))

    const controller = engine.rpcs.get(connection.id, 1)
    expect(controller).toBeDefined()

    // Hostile reuse of the same callId must produce NO response: an error
    // response would reject the pending call on the client side
    await send(encodeRpcMessage(1, 'test', {}))

    expect(call).toHaveBeenCalledTimes(1)
    expect(sent.length).toBe(0)

    // Original call survives: same controller, not aborted, responds normally
    expect(engine.rpcs.get(connection.id, 1)).toBe(controller)
    expect(controller!.signal.aborted).toBe(false)

    calls[0].resolve({ ok: true })
    await inFlight

    const responses = sentOfType(ServerMessageType.RpcResponse)
    expect(responses.length).toBe(1)
    const response = decodeRpcResponse(responses[0])
    expect(response.callId).toBe(1)
    expect(response.isError).toBe(false)
    expect(response.payload).toStrictEqual({ ok: true })

    await stop()
  })

  it('keeps an aborted callId reserved until the handler finishes', async () => {
    const { engine, call, calls, sent, connection, send, stop } =
      await createHarness()

    const inFlight = send(encodeRpcMessage(1, 'test', {}))
    const controller = engine.rpcs.get(connection.id, 1)

    // Abort-ignoring handler: the call promise stays pending after abort
    await send(encodeRpcAbort(1))
    expect(controller!.signal.aborted).toBe(true)

    // Immediate reuse must still be dropped, or the old context's disposal
    // would remove the new call's controller
    await send(encodeRpcMessage(1, 'test', {}))
    expect(call).toHaveBeenCalledTimes(1)
    expect(engine.rpcs.get(connection.id, 1)).toBe(controller)

    // Once the original call truly finishes, the id becomes reusable
    calls[0].resolve(null)
    await inFlight
    expect(engine.rpcs.get(connection.id, 1)).toBeUndefined()

    const inFlight2 = send(encodeRpcMessage(1, 'test', {}))
    expect(call).toHaveBeenCalledTimes(2)

    const controller2 = engine.rpcs.get(connection.id, 1)
    expect(controller2).toBeDefined()
    expect(controller2).not.toBe(controller)
    expect(controller2!.signal.aborted).toBe(false)

    // ...and the new call is abortable via its own controller
    await send(encodeRpcAbort(1))
    expect(controller2!.signal.aborted).toBe(true)

    calls[1].resolve(null)
    await inFlight2

    expect(sent.length).toBe(2)

    await stop()
  })
})
