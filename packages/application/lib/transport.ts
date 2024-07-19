import { randomUUID } from 'node:crypto'
import type { TServiceContract } from '@neematajs/contract'
import { BaseExtension } from './extension'
import type { Registry } from './registry'
import type { Subscription } from './subscription'

export interface BaseTransportData {
  transport: string
}

export abstract class BaseTransport<
  Type extends string = string,
  Connection extends BaseTransportConnection = BaseTransportConnection,
  Options = unknown,
> extends BaseExtension<Options, { type: Type; connection: Connection }> {
  abstract readonly type: Type
  abstract start(): any
  abstract stop(): any
}

// TODO: rethink transports/connections
export abstract class BaseTransportConnection {
  abstract readonly transport: string
  abstract readonly data: unknown

  readonly services: Set<string>

  constructor(
    protected readonly registry: Registry,
    services: string[],
    readonly id: string = randomUUID(),
    readonly subscriptions = new Map<string, Subscription>(),
  ) {
    this.services = new Set(services)
  }

  notify<
    C extends TServiceContract,
    E extends Extract<keyof C['events'], string>,
  >(
    contract: C,
    event: E,
    ...args: C['events'][E]['static']['payload'] extends never
      ? []
      : [C['events'][E]['static']['payload']]
  ) {
    if (!this.services.has(contract.name)) {
      throw new Error('Service contract not found')
    }

    if (!contract.events[event]) {
      throw new Error('Event contract not found')
    }

    let [payload] = args
    const schema = this.registry.schemas.get(contract.events[event].payload)
    if (schema) {
      const result = schema.encode(payload)
      if (!result.success) {
        throw new Error('Failed to encode payload', { cause: result.error })
      }
      payload = result.value
    }
    return this.sendEvent(contract.name, event, payload)
  }

  protected abstract sendEvent(
    serviceName: string,
    eventName: string,
    payload: any,
  ): boolean | null
}
