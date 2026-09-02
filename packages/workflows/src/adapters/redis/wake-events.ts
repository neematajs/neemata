import { EventEmitter } from 'node:events'

import type {
  WorkflowCommandWakeKind,
  WorkflowWakeEvents,
} from '../../runtime/wake-events.ts'
import type { WorkflowRedisClient } from './client.ts'
import type { RedisWorkflowKeys } from './keys.ts'

export class RedisWorkflowWakeEvents implements WorkflowWakeEvents {
  readonly #events = new EventEmitter()
  readonly #subscriber: WorkflowRedisClient
  readonly #subscriptions = new Map<string, number>()
  readonly #subscribedChannels = new Set<string>()
  readonly #uncertainChannels = new Set<string>()
  readonly #pendingReconciliations = new Map<string, Promise<boolean>>()
  #disposed = false

  constructor(
    client: WorkflowRedisClient,
    readonly keys: RedisWorkflowKeys,
  ) {
    this.#subscriber = client.duplicate({ lazyConnect: true })
    this.#subscriber.on('message', (channel: string) => {
      this.#events.emit(channel)
    })
    this.#subscriber.on('ready', () => {
      const channels = new Set([
        ...this.#subscriptions.keys(),
        ...this.#subscribedChannels,
        ...this.#uncertainChannels,
      ])
      for (const channel of channels) {
        // Reassert remote state after every reconnect; the local subscription
        // set cannot prove what the replacement connection restored.
        this.#uncertainChannels.add(channel)
        this.#reconcileSubscription(channel)
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
    this.#subscribedChannels.clear()
    this.#uncertainChannels.clear()
    await this.#subscriber.quit()
  }

  #listen(channel: string, listener: () => void) {
    if (this.#disposed) throw new Error('Redis workflow wake events disposed')
    const count = this.#subscriptions.get(channel) ?? 0
    this.#subscriptions.set(channel, count + 1)
    this.#events.on(channel, listener)
    this.#reconcileSubscription(channel)

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
      this.#reconcileSubscription(channel)
    }
  }

  #reconcileSubscription(channel: string) {
    if (this.#disposed || this.#pendingReconciliations.has(channel)) return

    // Redis subscriber commands share one connection. Keep each channel's
    // subscribe/unsubscribe sequence ordered so a listener removed and added
    // during an in-flight command cannot leave local and server state opposed.
    const pending = this.#reconcileChannel(channel).catch(() => false)
    this.#pendingReconciliations.set(channel, pending)
    void pending.then((reconciled) => {
      if (this.#pendingReconciliations.get(channel) !== pending) return
      this.#pendingReconciliations.delete(channel)
      if (reconciled && this.#needsReconciliation(channel)) {
        this.#reconcileSubscription(channel)
      }
    })
  }

  async #reconcileChannel(channel: string) {
    while (!this.#disposed) {
      const desired = this.#subscriptionIsDesired(channel)
      if (!this.#needsReconciliation(channel)) return true

      if (desired) {
        try {
          await this.#subscriber.subscribe(channel)
        } catch {
          this.#uncertainChannels.add(channel)
          // Polling remains authoritative. Reconnect retries this optional hint.
          return false
        }
        if (this.#disposed) return true
        this.#uncertainChannels.delete(channel)
        this.#subscribedChannels.add(channel)
        if (channel.startsWith(this.keys.runWake(''))) {
          // A run may change before the asynchronous subscription is active.
          // A coarse catch-up hint makes watchers reread durable state once it is.
          this.#events.emit(channel)
        }
      } else {
        try {
          await this.#subscriber.unsubscribe(channel)
        } catch {
          this.#uncertainChannels.add(channel)
          // Keep the channel marked subscribed so reconnect retries removal.
          return false
        }
        this.#uncertainChannels.delete(channel)
        this.#subscribedChannels.delete(channel)
      }
    }
    return true
  }

  #subscriptionIsDesired(channel: string) {
    return this.#subscriptions.has(channel)
  }

  #isSubscribed(channel: string) {
    return this.#subscribedChannels.has(channel)
  }

  #needsReconciliation(channel: string) {
    return (
      this.#uncertainChannels.has(channel) ||
      this.#subscriptionIsDesired(channel) !== this.#isSubscribed(channel)
    )
  }
}
