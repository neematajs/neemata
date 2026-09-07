import { beforeEach, describe, expect, it } from 'vitest'

import type { GatewayConnection } from '../src/connections.ts'
import { ConnectionManager } from '../src/connections.ts'

const createMockConnection = (
  id: string,
  overrides: Partial<GatewayConnection> = {},
): GatewayConnection => ({
  id,
  identity: `identity-${id}`,
  container: {} as GatewayConnection['container'],
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

  describe('connection properties', () => {
    it('should preserve all connection properties', () => {
      const abortController = new AbortController()
      const connection = createMockConnection('conn-1', {
        identity: 'custom-identity',
        abortController,
      })

      manager.add(connection)
      const retrieved = manager.get('conn-1')

      expect(retrieved.id).toBe('conn-1')
      expect(retrieved.identity).toBe('custom-identity')
      expect(retrieved.abortController).toBe(abortController)
    })
  })
})
