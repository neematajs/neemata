import { describe, expect, it, vi } from 'vitest'

import { StaticClient } from '../../src/clients/static.ts'
import {
  createStaticBidirectionalClient,
  createStaticUnidirectionalClient,
} from '../_setup.ts'

describe('StaticClient', () => {
  describe('Bidirectional transport proxy', () => {
    it('delegates nested calls to protected _call helper', async () => {
      const { client } = createStaticBidirectionalClient()
      const spy = vi
        .spyOn(client as any, '_call')
        .mockResolvedValue({ ok: true })

      const controller = new AbortController()
      const callers = client.call as any
      const result = await callers.users.list(
        { take: 1 },
        { signal: controller.signal },
      )

      expect(spy).toHaveBeenCalledWith(
        'users/list',
        { take: 1 },
        expect.objectContaining({ signal: controller.signal }),
      )
      expect(result).toEqual({ ok: true })
    })

    it('exposes nested proxies without triggering thenable traps', () => {
      const { client } = createStaticBidirectionalClient()
      const callers = client.call as any
      expect(typeof callers.users.list).toBe('function')
      expect(() => {
        void callers.users.then
      }).not.toThrow()
    })

    it('delegates calls when safe mode is enabled', async () => {
      const { client, transport } = createStaticBidirectionalClient()
      const safeClient = new StaticClient(
        { ...client.options, safe: true },
        transport,
        undefined,
      )
      const callers = safeClient.call as any
      const spy = vi
        .spyOn(safeClient as any, '_call')
        .mockResolvedValue({ ok: true })

      await callers.users.list()
      expect(spy).toHaveBeenCalledWith('users/list', undefined, undefined)
    })
  })

  describe('Unidirectional transport proxy', () => {
    it('delegates calls through unidirectional transport', async () => {
      const { client, call, format } = createStaticUnidirectionalClient()
      const callers = client.call as any

      await client.connect()
      const result = await callers.users.list({ take: 1 })

      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({ format }),
        expect.objectContaining({ procedure: 'users/list' }),
        expect.objectContaining({ signal: undefined }),
      )
      expect(result).toEqual({ ok: true })
    })
  })
})
