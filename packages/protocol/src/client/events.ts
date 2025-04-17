import type { Callback } from '@nmtjs/common'

export type EventMap = { [K: string]: any[] }

/**
 * Very simple node-like event emitter wrapper around EventTarget
 *
 * @todo add errors and promise rejections handling
 */
export class EventEmitter<
  Events extends EventMap = EventMap,
  EventNames extends Extract<keyof Events, string> = Extract<
    keyof Events,
    string
  >,
> {
  static once(ee: EventEmitter, event: string) {
    return new Promise((resolve) => ee.once(event, resolve))
  }

  #target = new EventTarget()
  #listeners = new Map<Callback, Callback>()

  on<E extends EventNames>(
    event: E | (Object & string),
    listener: (...args: Events[E]) => void,
    options?: AddEventListenerOptions,
  ) {
    const wrapper = (event) => listener(...event.detail)
    this.#listeners.set(listener, wrapper)
    this.#target.addEventListener(event, wrapper, options)
    return () => this.#target.removeEventListener(event, wrapper)
  }

  once<E extends EventNames>(
    event: E | (Object & string),
    listener: (...args: Events[E]) => void,
    options?: AddEventListenerOptions,
  ) {
    return this.on(event, listener, { ...options, once: true })
  }

  off(event: EventNames | (Object & string), listener: Callback) {
    const wrapper = this.#listeners.get(listener)
    if (wrapper) this.#target.removeEventListener(event, wrapper)
  }

  emit<E extends EventNames | (Object & string)>(
    event: E,
    ...args: E extends EventEmitter ? Events[E] : any[]
  ) {
    return this.#target.dispatchEvent(new CustomEvent(event, { detail: args }))
  }
}
