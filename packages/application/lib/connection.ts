import { randomUUID } from 'node:crypto'
import type { TServiceContract } from '@nmtjs/contract'
import type { NeverType, t } from '@nmtjs/type'

import type { Registry } from './registry.ts'
import type { Subscription } from './subscription.ts'

export type ConnectionSendEvent = (
  service: string,
  event: string,
  payload: any,
) => boolean | null

export type ConnectionOptions<Type extends string = string> = {
  type: Type
  services: string[]
  sendEvent?: ConnectionSendEvent
  id?: string
  subscriptions?: Map<string, Subscription>
  data?: unknown
}

export class Connection<Type extends string = string> {
  readonly id: string
  readonly type: Type
  readonly services: Set<string>
  readonly subscriptions: Map<string, Subscription>

  #registry: Registry
  #sendEvent?: ConnectionSendEvent

  constructor(options: ConnectionOptions<Type>, registry: Registry) {
    this.id = options.id ?? randomUUID()
    this.type = options.type
    this.services = new Set(options.services ?? [])
    this.subscriptions = options.subscriptions ?? new Map()

    this.#registry = registry
    this.#sendEvent = options.sendEvent
  }

  notify<
    C extends TServiceContract,
    E extends Extract<keyof C['events'], string>,
  >(
    contract: C,
    event: E,
    ...args: C['events'][E]['payload'] extends NeverType
      ? []
      : [payload: t.infer.decoded<C['events'][E]['payload']>]
  ) {
    if (!this.#sendEvent)
      throw new Error('This connection does not support event notification')

    if (!this.services.has(contract.name)) {
      throw new Error('Service contract not found')
    }

    if (!contract.events[event]) {
      throw new Error('Event contract not found')
    }

    let [payload] = args

    const schema = this.#registry.schemas.get(contract.events[event].payload)

    if (schema) {
      const result = schema.encodeSafe(payload)
      if (!result.success) {
        throw new Error('Failed to encode payload', { cause: result.error })
      }
      payload = result.value
    }

    return this.#sendEvent(contract.name, event, payload)
  }
}
