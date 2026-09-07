import { ServerMessageType } from '@nmtjs/protocol'
import { describe, expect, it, vi } from 'vitest'

import { createEngineHarness, encodePong } from './_helpers/engine.ts'

describe('WS session heartbeat', () => {
  it('sends server Ping and accepts client Pong', async () => {
    vi.useFakeTimers()
    try {
      const { sent, send, close, stop } = await createEngineHarness({
        heartbeat: { interval: 1000, timeout: 500 },
      })

      // First ping after 1s
      await vi.advanceTimersByTimeAsync(1000)

      expect(sent.length).toBe(1)
      expect(sent[0].type).toBe(ServerMessageType.Ping)

      const nonce = sent[0].id

      await send(encodePong(nonce))

      // No close should happen
      expect(close).not.toHaveBeenCalled()

      await stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminates the connection if Pong is not received', async () => {
    vi.useFakeTimers()
    try {
      const { connection, close, stop } = await createEngineHarness({
        heartbeat: { interval: 1000, timeout: 500 },
      })

      // Send ping
      await vi.advanceTimersByTimeAsync(1000)

      // Wait beyond timeout without pong
      await vi.advanceTimersByTimeAsync(500)

      expect(close).toHaveBeenCalledWith(connection.id, {
        code: 1001,
        reason: 'heartbeat_timeout',
      })

      await stop()
    } finally {
      vi.useRealTimers()
    }
  })
})
