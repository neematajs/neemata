import { EventEmitter } from 'node:events'

import type {
  WorkflowCommandWakeKind,
  WorkflowWakeEvents,
} from '../../runtime/wake-events.ts'
import type { WorkflowRedisClient } from './client.ts'
import type { Keys } from './keys.ts'

export class WakeEvents implements WorkflowWakeEvents {
  readonly #events = new EventEmitter()
  readonly #subscriber: WorkflowRedisClient
  readonly #subscriptions = new Map<string, number>()
  readonly #subscribed = new Set<string>()
  readonly #uncertain = new Set<string>()
  readonly #pending = new Map<string, Promise<boolean>>()
  #disposed = false

  constructor(
    client: WorkflowRedisClient,
    readonly keys: Keys,
  ) {
    this.#subscriber = client.duplicate({ lazyConnect: true })
    this.#subscriber.on('message', (channel: string) => {
      this.#events.emit(channel)
    })
    this.#subscriber.on('ready', () => {
      const channels = new Set([
        ...this.#subscriptions.keys(),
        ...this.#subscribed,
        ...this.#uncertain,
      ])
      for (const channel of channels) {
        // Reassert remote state after every reconnect; the local subscription
        // set cannot prove what the replacement connection restored.
        this.#uncertain.add(channel)
        this.#scheduleReconcile(channel)
      }
    })
    // Wake notifications are optional hints; connection failures fall back to
    // polling and must not become unhandled EventEmitter errors.
    this.#subscriber.on('error', () => {})
  }

  async initialize() {
    if (this.#subscriber.status === 'wait') await this.#subscriber.connect()
  }

  onCommand(kind: WorkflowCommandWakeKind, listener: () => void) {
    return this.#listen(this.keys.commandWake(kind), listener)
  }

  onCancellation(runId: string, listener: () => void) {
    return this.#listen(this.keys.cancellationWake(runId), listener)
  }

  onRunEvent(rootRunId: string, listener: () => void) {
    return this.#listen(this.keys.runWake(rootRunId), listener)
  }

  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    this.#events.removeAllListeners()
    this.#subscriptions.clear()
    this.#subscribed.clear()
    this.#uncertain.clear()
    await this.#subscriber.quit()
  }

  #listen(channel: string, listener: () => void) {
    if (this.#disposed) throw new Error('Redis workflow wake events disposed')
    const count = this.#subscriptions.get(channel) ?? 0
    this.#subscriptions.set(channel, count + 1)
    this.#events.on(channel, listener)
    this.#scheduleReconcile(channel)

    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.#events.off(channel, listener)
      const current = this.#subscriptions.get(channel) ?? 1
      if (current > 1) {
        this.#subscriptions.set(channel, current - 1)
        return
      }
      this.#subscriptions.delete(channel)
      this.#scheduleReconcile(channel)
    }
  }

  #scheduleReconcile(channel: string) {
    if (this.#disposed || this.#pending.has(channel)) return

    // Redis subscriber commands share one connection. Keep each channel's
    // subscribe/unsubscribe sequence ordered so a listener removed and added
    // during an in-flight command cannot leave local and server state opposed.
    const pending = this.#reconcile(channel).catch(() => false)
    this.#pending.set(channel, pending)
    void pending.then((reconciled) => {
      if (this.#pending.get(channel) !== pending) return
      this.#pending.delete(channel)
      if (reconciled && this.#needsReconcile(channel)) {
        this.#scheduleReconcile(channel)
      }
    })
  }

  async #reconcile(channel: string) {
    while (!this.#disposed) {
      const desired = this.#subscriptions.has(channel)
      if (!this.#needsReconcile(channel)) return true

      if (desired) {
        try {
          await this.#subscriber.subscribe(channel)
        } catch {
          this.#uncertain.add(channel)
          // Polling remains authoritative. Reconnect retries this optional hint.
          return false
        }
        if (this.#disposed) return true
        this.#uncertain.delete(channel)
        this.#subscribed.add(channel)
        if (channel.startsWith(this.keys.runWake(''))) {
          // A run may change before the asynchronous subscription is active.
          // A coarse catch-up hint makes watchers reread durable state once it is.
          this.#events.emit(channel)
        }
      } else {
        try {
          await this.#subscriber.unsubscribe(channel)
        } catch {
          this.#uncertain.add(channel)
          // Keep the channel marked subscribed so reconnect retries removal.
          return false
        }
        this.#uncertain.delete(channel)
        this.#subscribed.delete(channel)
      }
    }
    return true
  }

  #needsReconcile(channel: string) {
    return (
      this.#uncertain.has(channel) ||
      this.#subscriptions.has(channel) !== this.#subscribed.has(channel)
    )
  }
}
