import { expect, test, vi } from 'vitest'

import {
  createPostgresWorkflowWakeEvents,
  type WorkflowPostgresListenerClient,
  type WorkflowPostgresNotification,
} from '../src/adapters/postgres.ts'

type FakeListenerClient = WorkflowPostgresListenerClient & {
  emit(event: 'notification' | 'error' | 'end', arg?: unknown): void
}

function createFakeListenerClient(): FakeListenerClient {
  const listeners = new Map<string, Set<(arg?: unknown) => void>>()
  return {
    async query() {
      return undefined
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      listeners.set(event, set)
      set.add(listener)
      return undefined
    },
    end() {},
    emit(event, arg) {
      for (const listener of listeners.get(event) ?? []) listener(arg)
    },
  }
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test('retries after a LISTEN failure that never drops the connection', async () => {
  vi.useFakeTimers()
  try {
    const clients: FakeListenerClient[] = []
    let failListenOnce = true
    const wakeEvents = createPostgresWorkflowWakeEvents({
      connect: async () => {
        const client = createFakeListenerClient()
        if (failListenOnce) {
          failListenOnce = false
          client.query = async () => {
            throw new Error('LISTEN rejected')
          }
        }
        clients.push(client)
        return client
      },
      reconnectDelayMs: 10,
    })

    let commandWakes = 0
    wakeEvents.onCommand('continue', () => {
      commandWakes += 1
    })

    // first attempt claims the client slot, then LISTEN rejects without the
    // connection emitting error/end — the slot must be released so the
    // scheduled retry actually connects instead of no-oping forever
    await vi.advanceTimersByTimeAsync(0)
    expect(clients).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(clients).toHaveLength(2)

    clients[1]!.emit('notification', {
      channel: 'workflow_commands',
      payload: 'continue',
    } satisfies WorkflowPostgresNotification)
    expect(commandWakes).toBe(1)

    await wakeEvents.dispose()
  } finally {
    vi.useRealTimers()
    await flush()
  }
})

test('fires a synthetic wake to all listeners on reconnect, not on first connect', async () => {
  vi.useFakeTimers()
  try {
    const clients: FakeListenerClient[] = []
    const wakeEvents = createPostgresWorkflowWakeEvents({
      connect: async () => {
        const client = createFakeListenerClient()
        clients.push(client)
        return client
      },
      reconnectDelayMs: 10,
    })

    let commandWakes = 0
    let cancellationWakes = 0
    let runEventWakes = 0
    wakeEvents.onCommand('continue', () => {
      commandWakes += 1
    })
    wakeEvents.onCancellation('run-1', () => {
      cancellationWakes += 1
    })
    wakeEvents.onRunEvent!('root-1', () => {
      runEventWakes += 1
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(clients).toHaveLength(1)
    // first connect: no gap to heal, no pulse
    expect(commandWakes).toBe(0)
    expect(cancellationWakes).toBe(0)
    expect(runEventWakes).toBe(0)

    // notifications still dispatch normally
    clients[0]!.emit('notification', {
      channel: 'workflow_commands',
      payload: 'continue',
    } satisfies WorkflowPostgresNotification)
    expect(commandWakes).toBe(1)

    // connection loss → reconnect → every subscriber gets one pulse, because
    // anything notified during the gap is unrecoverable
    clients[0]!.emit('end')
    await vi.advanceTimersByTimeAsync(10)
    expect(clients).toHaveLength(2)
    expect(commandWakes).toBe(2)
    expect(cancellationWakes).toBe(1)
    expect(runEventWakes).toBe(1)

    await wakeEvents.dispose()
  } finally {
    vi.useRealTimers()
    await flush()
  }
})
