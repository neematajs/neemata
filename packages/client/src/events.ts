import type { Callback } from '@nmtjs/common'

export type EventMap = { [K: string]: any[] }

// TODO: add errors and promise rejections handling
/**
 * Thin node-like event emitter wrapper around EventTarget
 */
export class EventEmitter<
  Events extends EventMap = EventMap,
  EventName extends Extract<keyof Events, string> = Extract<
    keyof Events,
    string
  >,
> {
  #target = new EventTarget()
  #listeners = new Map<Callback, Callback>()

  on<E extends EventName>(
    event: E | (Object & string),
    listener: (...args: Events[E]) => void,
    options?: AddEventListenerOptions,
  ) {
    const wrapper = (event) => listener(...event.detail)
    this.#listeners.set(listener, wrapper)
    this.#target.addEventListener(event, wrapper, options)
    return () => this.#target.removeEventListener(event, wrapper)
  }

  once<E extends EventName>(
    event: E | (Object & string),
    listener: (...args: Events[E]) => void,
    options?: AddEventListenerOptions,
  ) {
    return this.on(event, listener, { ...options, once: true })
  }

  off(event: EventName | (Object & string), listener: Callback) {
    const wrapper = this.#listeners.get(listener)
    if (wrapper) this.#target.removeEventListener(event, wrapper)
  }

  emit<E extends EventName | (Object & string)>(
    event: E,
    ...args: E extends EventName ? Events[E] : any[]
  ) {
    return this.#target.dispatchEvent(new CustomEvent(event, { detail: args }))
  }
}

export const once = <
  T extends EventEmitter,
  EventMap extends T extends EventEmitter<infer E, any> ? E : never,
  EventName extends T extends EventEmitter<any, infer N> ? N : never,
>(
  ee: T,
  event: EventName,
  signal?: AbortSignal,
) => {
  return new Promise<EventMap[EventName]>((resolve) => {
    ee.once(event, resolve, { signal })
  })
}
