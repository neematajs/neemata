import { MAX_UINT32 } from '@nmtjs/common'
import { ConnectionType } from '@nmtjs/protocol'
import { beforeEach, describe, expect, it } from 'vitest'

import type { GatewayConnection } from '../src/connections.ts'
import { ConnectionManager } from '../src/connections.ts'

const createMockConnection = (
  id: string,
  overrides: Partial<GatewayConnection> = {},
): GatewayConnection => ({
  id,
  type: ConnectionType.Bidirectional,
  transport: 'ws',
  protocol: {} as GatewayConnection['protocol'],
  identity: `identity-${id}`,
  container: {} as GatewayConnection['container'],
  encoder: {} as GatewayConnection['encoder'],
  decoder: {} as GatewayConnection['decoder'],
  abortController: new AbortController(),
  ...overrides,
})

describe('ConnectionManager', () => {
  let manager: ConnectionManager

  beforeEach(() => {
    manager = new ConnectionManager()
  })

  describe('add', () => {
    it('should add a connection', () => {
      const connection = createMockConnection('conn-1')
      manager.add(connection)

      expect(manager.has('conn-1')).toBe(true)
    })

    it('should initialize stream id for connection', () => {
      const connection = createMockConnection('conn-1')
      manager.add(connection)

      const streamId = manager.getStreamId('conn-1')
      expect(streamId).toBe(0)
    })

    it('should allow adding multiple connections', () => {
      const conn1 = createMockConnection('conn-1')
      const conn2 = createMockConnection('conn-2')

      manager.add(conn1)
      manager.add(conn2)

      expect(manager.has('conn-1')).toBe(true)
      expect(manager.has('conn-2')).toBe(true)
    })
  })

  describe('get', () => {
    it('should return a connection by id', () => {
      const connection = createMockConnection('conn-1')
      manager.add(connection)

      const result = manager.get('conn-1')
      expect(result).toBe(connection)
    })

    it('should throw when connection not found', () => {
      expect(() => manager.get('non-existent')).toThrow('Connection not found')
    })
  })

  describe('has', () => {
    it('should return true for existing connection', () => {
      const connection = createMockConnection('conn-1')
      manager.add(connection)

      expect(manager.has('conn-1')).toBe(true)
    })

    it('should return false for non-existing connection', () => {
      expect(manager.has('non-existent')).toBe(false)
    })
  })

  describe('remove', () => {
    it('should remove a connection', () => {
      const connection = createMockConnection('conn-1')
      manager.add(connection)

      manager.remove('conn-1')

      expect(manager.has('conn-1')).toBe(false)
    })

    it('should clean up stream id when removing connection', () => {
      const connection = createMockConnection('conn-1')
      manager.add(connection)
      manager.getStreamId('conn-1') // increment stream id

      manager.remove('conn-1')

      // Re-add should start from 0 again
      manager.add(connection)
      expect(manager.getStreamId('conn-1')).toBe(0)
    })

    it('should not throw when removing non-existent connection', () => {
      expect(() => manager.remove('non-existent')).not.toThrow()
    })
  })

  describe('getAll', () => {
    it('should return empty iterator when no connections', () => {
      const connections = [...manager.getAll()]
      expect(connections).toHaveLength(0)
    })

    it('should return all connections', () => {
      const conn1 = createMockConnection('conn-1')
      const conn2 = createMockConnection('conn-2')
      const conn3 = createMockConnection('conn-3')

      manager.add(conn1)
      manager.add(conn2)
      manager.add(conn3)

      const connections = [...manager.getAll()]
      expect(connections).toHaveLength(3)
      expect(connections).toContain(conn1)
      expect(connections).toContain(conn2)
      expect(connections).toContain(conn3)
    })
  })

  describe('getStreamId', () => {
    it('should return incrementing stream ids', () => {
      const connection = createMockConnection('conn-1')
      manager.add(connection)

      expect(manager.getStreamId('conn-1')).toBe(0)
      expect(manager.getStreamId('conn-1')).toBe(1)
      expect(manager.getStreamId('conn-1')).toBe(2)
    })

    it('should track stream ids per connection', () => {
      const conn1 = createMockConnection('conn-1')
      const conn2 = createMockConnection('conn-2')

      manager.add(conn1)
      manager.add(conn2)

      expect(manager.getStreamId('conn-1')).toBe(0)
      expect(manager.getStreamId('conn-1')).toBe(1)
      expect(manager.getStreamId('conn-2')).toBe(0)
      expect(manager.getStreamId('conn-1')).toBe(2)
      expect(manager.getStreamId('conn-2')).toBe(1)
    })

    it('should wrap around at MAX_UINT32', () => {
      const connection = createMockConnection('conn-1')
      manager.add(connection)

      // Manually set stream id to MAX_UINT32 via repeated calls
      // We can't directly set it, so we'll test the logic by examining the behavior
      // The implementation checks if streamId >= MAX_UINT32, then resets to 0

      // Get access to private streamIds map via the add method side effect
      // Since we can't access private fields directly, we test the wrap-around
      // by simulating what happens after MAX_UINT32 calls
      const accessPrivate = (manager as any).streamIds as Map<string, number>
      accessPrivate.set('conn-1', MAX_UINT32)

      // Should reset to 0 and then increment
      expect(manager.getStreamId('conn-1')).toBe(0)
      expect(manager.getStreamId('conn-1')).toBe(1)
    })
  })

  describe('connection properties', () => {
    it('should preserve all connection properties', () => {
      const abortController = new AbortController()
      const connection = createMockConnection('conn-1', {
        type: ConnectionType.Unidirectional,
        transport: 'http',
        identity: 'custom-identity',
        abortController,
      })

      manager.add(connection)
      const retrieved = manager.get('conn-1')

      expect(retrieved.id).toBe('conn-1')
      expect(retrieved.type).toBe(ConnectionType.Unidirectional)
      expect(retrieved.transport).toBe('http')
      expect(retrieved.identity).toBe('custom-identity')
      expect(retrieved.abortController).toBe(abortController)
    })
  })
})
