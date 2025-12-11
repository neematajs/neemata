import { beforeEach, describe, expect, it } from 'vitest'

import { RpcManager } from '../src/rpcs.ts'

describe('RpcManager', () => {
  let manager: RpcManager

  beforeEach(() => {
    manager = new RpcManager()
  })

  describe('set', () => {
    it('should store an RPC with connection and call id', () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      expect(manager.get('conn-1', 1)).toBe(controller)
    })

    it('should allow multiple RPCs per connection', () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()

      manager.set('conn-1', 1, controller1)
      manager.set('conn-1', 2, controller2)

      expect(manager.get('conn-1', 1)).toBe(controller1)
      expect(manager.get('conn-1', 2)).toBe(controller2)
    })

    it('should allow same call id for different connections', () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()

      manager.set('conn-1', 1, controller1)
      manager.set('conn-2', 1, controller2)

      expect(manager.get('conn-1', 1)).toBe(controller1)
      expect(manager.get('conn-2', 1)).toBe(controller2)
    })
  })

  describe('get', () => {
    it('should return the abort controller for an RPC', () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      expect(manager.get('conn-1', 1)).toBe(controller)
    })

    it('should return undefined for non-existent RPC', () => {
      expect(manager.get('conn-1', 1)).toBeUndefined()
    })
  })

  describe('delete', () => {
    it('should remove an RPC', () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      manager.delete('conn-1', 1)

      expect(manager.get('conn-1', 1)).toBeUndefined()
    })

    it('should not throw when deleting non-existent RPC', () => {
      expect(() => manager.delete('conn-1', 999)).not.toThrow()
    })

    it('should not affect other RPCs', () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()

      manager.set('conn-1', 1, controller1)
      manager.set('conn-1', 2, controller2)

      manager.delete('conn-1', 1)

      expect(manager.get('conn-1', 1)).toBeUndefined()
      expect(manager.get('conn-1', 2)).toBe(controller2)
    })
  })

  describe('abort', () => {
    it('should abort the controller', () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      manager.abort('conn-1', 1)

      expect(controller.signal.aborted).toBe(true)
      expect(controller.signal.reason).toBeInstanceOf(DOMException)
    })

    it('should use standard DOMException as reason', () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      manager.abort('conn-1', 1)

      expect(controller.signal.reason).toBeInstanceOf(DOMException)
    })

    it('should remove the RPC after aborting', () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      manager.abort('conn-1', 1)

      expect(manager.get('conn-1', 1)).toBeUndefined()
    })

    it('should release pending pull when aborting', async () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      const pullPromise = manager.awaitPull('conn-1', 1)

      // Abort should resolve the pull promise
      manager.abort('conn-1', 1)

      await expect(pullPromise).resolves.toBeUndefined()
    })

    it('should do nothing for non-existent RPC', () => {
      expect(() => manager.abort('conn-1', 999)).not.toThrow()
    })
  })

  describe('awaitPull', () => {
    it('should throw if RPC does not exist', () => {
      expect(() => manager.awaitPull('conn-1', 1)).toThrow('RPC not found')
    })

    it('should return a promise that resolves when released', async () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      const pullPromise = manager.awaitPull('conn-1', 1)

      // Promise should be pending
      let resolved = false
      pullPromise.then(() => {
        resolved = true
      })

      // Give a tick for potential immediate resolution
      await Promise.resolve()
      expect(resolved).toBe(false)

      manager.releasePull('conn-1', 1)

      await pullPromise
      expect(resolved).toBe(true)
    })

    it('should return same promise for multiple awaits', async () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      const promise1 = manager.awaitPull('conn-1', 1)
      const promise2 = manager.awaitPull('conn-1', 1)

      expect(promise1).toBe(promise2)

      manager.releasePull('conn-1', 1)
      await promise1
    })
  })

  describe('releasePull', () => {
    it('should resolve pending pull promise', async () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      const pullPromise = manager.awaitPull('conn-1', 1)

      manager.releasePull('conn-1', 1)

      await expect(pullPromise).resolves.toBeUndefined()
    })

    it('should clean up the stream entry', async () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      manager.awaitPull('conn-1', 1)
      manager.releasePull('conn-1', 1)

      // Second awaitPull should create a new future
      const newPromise = manager.awaitPull('conn-1', 1)
      expect(newPromise).toBeDefined()

      manager.releasePull('conn-1', 1)
      await newPromise
    })

    it('should do nothing if no pending pull', () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      // Should not throw
      expect(() => manager.releasePull('conn-1', 1)).not.toThrow()
    })
  })

  describe('close', () => {
    it('should abort all RPCs for a connection', () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()
      const controller3 = new AbortController()

      manager.set('conn-1', 1, controller1)
      manager.set('conn-1', 2, controller2)
      manager.set('conn-2', 1, controller3)

      manager.close('conn-1')

      expect(controller1.signal.aborted).toBe(true)
      expect(controller2.signal.aborted).toBe(true)
      expect(controller3.signal.aborted).toBe(false)
    })

    it('should use standard DOMException for abort reason', () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      manager.close('conn-1')

      expect(controller.signal.reason).toBeInstanceOf(DOMException)
    })

    it('should use standard DOMException when closing', () => {
      const controller = new AbortController()
      manager.set('conn-1', 1, controller)

      manager.close('conn-1')

      expect(controller.signal.reason).toBeInstanceOf(DOMException)
    })

    it('should remove all RPCs for the connection', () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()

      manager.set('conn-1', 1, controller1)
      manager.set('conn-1', 2, controller2)

      manager.close('conn-1')

      expect(manager.get('conn-1', 1)).toBeUndefined()
      expect(manager.get('conn-1', 2)).toBeUndefined()
    })

    it('should not affect other connections', () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()

      manager.set('conn-1', 1, controller1)
      manager.set('conn-2', 1, controller2)

      manager.close('conn-1')

      expect(manager.get('conn-2', 1)).toBe(controller2)
    })

    it('should do nothing for connection with no RPCs', () => {
      expect(() => manager.close('non-existent')).not.toThrow()
    })

    it('should resolve pending stream pulls for the connection', async () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()

      manager.set('conn-1', 1, controller1)
      manager.set('conn-1', 2, controller2)

      const pullPromise1 = manager.awaitPull('conn-1', 1)
      const pullPromise2 = manager.awaitPull('conn-1', 2)

      manager.close('conn-1')

      await expect(pullPromise1).resolves.toBeUndefined()
      await expect(pullPromise2).resolves.toBeUndefined()
    })

    it('should not accidentally match similar connection ids', () => {
      const controller1 = new AbortController()
      const controller2 = new AbortController()

      // conn-1 and conn-10 both start with "conn-1"
      manager.set('conn-1', 1, controller1)
      manager.set('conn-10', 1, controller2)

      manager.close('conn-1')

      expect(controller1.signal.aborted).toBe(true)
      // conn-10 should NOT be affected because the key format is "conn-1:1"
      // and "conn-10:1" does not start with "conn-1:"
      expect(controller2.signal.aborted).toBe(false)
    })
  })
})
