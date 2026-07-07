import type {
  WorkflowCommandWakeKind,
  WorkflowWakeEvents,
} from '../../runtime/wake-events.ts'
import {
  WORKFLOW_CANCELLATIONS_CHANNEL,
  WORKFLOW_COMMANDS_CHANNEL,
} from './sql.ts'

const DEFAULT_RECONNECT_DELAY_MS = 1_000

export type WorkflowPostgresNotification = {
  readonly channel: string
  readonly payload?: string | undefined
}

/**
 * Minimal surface of a dedicated LISTEN connection; a connected `pg` Client
 * satisfies it as-is.
 */
export type WorkflowPostgresListenerClient = {
  query(sql: string): Promise<unknown>
  on(
    event: 'notification' | 'error' | 'end',
    listener: (arg?: any) => void,
  ): unknown
  end(): Promise<void> | void
}

export type CreatePostgresWorkflowWakeEventsParams = {
  /**
   * Creates a connected client dedicated to LISTEN. Called again after
   * connection loss; keep it cheap and side-effect free beyond connecting.
   */
  readonly connect: () => Promise<WorkflowPostgresListenerClient>
  readonly reconnectDelayMs?: number
  readonly onError?: (error: unknown) => void
}

export type PostgresWorkflowWakeEvents = WorkflowWakeEvents & {
  dispose(): Promise<void>
}

/**
 * LISTEN/NOTIFY-backed wake events for the Postgres workflow runtime. Purely
 * a latency optimization: notifications lost to disconnects are absorbed by
 * the poll/heartbeat fallback, so reconnection is best-effort with backoff.
 */
export function createPostgresWorkflowWakeEvents(
  params: CreatePostgresWorkflowWakeEventsParams,
): PostgresWorkflowWakeEvents {
  const reconnectDelayMs = params.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS
  const commandListeners = new Map<WorkflowCommandWakeKind, Set<() => void>>()
  const cancellationListeners = new Map<string, Set<() => void>>()

  let disposed = false
  let client: WorkflowPostgresListenerClient | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined

  // shutdown intentionally interrupts in-flight connect/LISTEN work; don't
  // surface those interruptions as errors
  const reportError = (error: unknown) => {
    if (!disposed) params.onError?.(error)
  }

  const fire = (listeners: Set<() => void> | undefined) => {
    if (!listeners) return
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        reportError(error)
      }
    }
  }

  const handleNotification = (message: WorkflowPostgresNotification) => {
    if (message.channel === WORKFLOW_COMMANDS_CHANNEL) {
      if (message.payload) {
        fire(commandListeners.get(message.payload as WorkflowCommandWakeKind))
      }
      return
    }
    if (message.channel === WORKFLOW_CANCELLATIONS_CHANNEL) {
      if (message.payload) fire(cancellationListeners.get(message.payload))
    }
  }

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect()
    }, reconnectDelayMs)
    // don't hold the process open just to keep a wake-up hint alive
    if (typeof reconnectTimer === 'object' && 'unref' in reconnectTimer) {
      reconnectTimer.unref()
    }
  }

  const connect = async () => {
    if (disposed || client) return
    try {
      const connected = await params.connect()
      if (disposed) {
        await connected.end()
        return
      }
      client = connected
      let lost = false
      const onLost = (error?: unknown) => {
        if (error) reportError(error)
        if (lost) return
        lost = true
        client = undefined
        scheduleReconnect()
      }
      connected.on('notification', handleNotification)
      connected.on('error', onLost)
      connected.on('end', () => onLost())
      await connected.query(
        `LISTEN "${WORKFLOW_COMMANDS_CHANNEL}"; LISTEN "${WORKFLOW_CANCELLATIONS_CHANNEL}"`,
      )
    } catch (error) {
      reportError(error)
      scheduleReconnect()
    }
  }

  void connect()

  const subscribe = <K>(
    listeners: Map<K, Set<() => void>>,
    key: K,
    listener: () => void,
  ) => {
    const set = listeners.get(key) ?? new Set<() => void>()
    listeners.set(key, set)
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(key)
    }
  }

  return {
    onCommand: (kind, listener) => subscribe(commandListeners, kind, listener),
    onCancellation: (runId, listener) =>
      subscribe(cancellationListeners, runId, listener),
    async dispose() {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      commandListeners.clear()
      cancellationListeners.clear()
      const current = client
      client = undefined
      try {
        await current?.end()
      } catch (error) {
        params.onError?.(error)
      }
    },
  }
}
