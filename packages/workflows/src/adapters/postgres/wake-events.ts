import type {
  WorkflowCommandWakeKind,
  WorkflowWakeEvents,
} from '../../runtime/wake-events.ts'
import {
  WORKFLOW_CANCELLATIONS_CHANNEL,
  WORKFLOW_COMMANDS_CHANNEL,
  WORKFLOW_RUN_EVENTS_CHANNEL,
} from './constants.ts'

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
    // `any` keeps handlers with a typed argument assignable, as pg's own
    // overloads allow
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
  // One map per LISTEN channel, keyed by the notification payload (command
  // kind, run id, root run id).
  const byChannel: Record<string, Map<string, Set<() => void>>> = {
    [WORKFLOW_COMMANDS_CHANNEL]: new Map(),
    [WORKFLOW_CANCELLATIONS_CHANNEL]: new Map(),
    [WORKFLOW_RUN_EVENTS_CHANNEL]: new Map(),
  }

  let disposed = false
  let client: WorkflowPostgresListenerClient | undefined
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let everListened = false

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
    const listeners = byChannel[message.channel]
    if (!listeners || !message.payload) return
    fire(listeners.get(message.payload))
  }

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connect()
    }, reconnectDelayMs)
    // don't hold the process open just to keep a wake-up hint alive
    reconnectTimer.unref()
  }

  const connect = async () => {
    if (disposed || client) return
    let connected: WorkflowPostgresListenerClient | undefined
    try {
      connected = await params.connect()
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
      connected.on('notification', (message) =>
        handleNotification(message as WorkflowPostgresNotification),
      )
      connected.on('error', onLost)
      connected.on('end', () => onLost())
      await connected.query(
        `LISTEN "${WORKFLOW_COMMANDS_CHANNEL}"; LISTEN "${WORKFLOW_CANCELLATIONS_CHANNEL}"; LISTEN "${WORKFLOW_RUN_EVENTS_CHANNEL}"`,
      )
      // Reconnect pulse: everything notified during the gap is lost, and there
      // is no history to replay, so tell every subscriber "maybe changed" —
      // wakes are idempotent, so a spurious one costs one refetch/claim pass,
      // never correctness. Heals watchers and worker dispatch alike.
      if (everListened) {
        for (const channel of Object.values(byChannel)) {
          for (const listeners of channel.values()) fire(listeners)
        }
      }
      everListened = true
    } catch (error) {
      // a LISTEN failure after the slot was claimed must release it, or the
      // scheduled retry no-ops on the `client` guard and the hub silently
      // degrades to poll-only forever
      if (connected !== undefined && client === connected) {
        client = undefined
        try {
          await connected.end()
        } catch {}
      }
      reportError(error)
      scheduleReconnect()
    }
  }

  void connect()

  const subscribe = (channel: string, key: string, listener: () => void) => {
    const listeners = byChannel[channel]!
    const set = listeners.get(key) ?? new Set<() => void>()
    listeners.set(key, set)
    set.add(listener)
    return () => {
      set.delete(listener)
      if (set.size === 0) listeners.delete(key)
    }
  }

  return {
    onCommand: (kind: WorkflowCommandWakeKind, listener) =>
      subscribe(WORKFLOW_COMMANDS_CHANNEL, kind, listener),
    onCancellation: (runId, listener) =>
      subscribe(WORKFLOW_CANCELLATIONS_CHANNEL, runId, listener),
    onRunEvent: (rootRunId, listener) =>
      subscribe(WORKFLOW_RUN_EVENTS_CHANNEL, rootRunId, listener),
    async dispose() {
      disposed = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      for (const listeners of Object.values(byChannel)) listeners.clear()
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
