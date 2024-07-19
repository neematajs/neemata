export type EventMap = { [K: string]: any[] }

export function forAbort(signal: AbortSignal) {
  return new Promise((_, reject) => {
    const handler = () => reject(new Error('aborted'))
    const options = { once: true }
    signal.addEventListener('abort', handler, options)
  })
}

export function onAbort(signal: AbortSignal, listener: () => void) {
  signal.addEventListener('abort', listener, { once: true })
  return () => signal.removeEventListener('abort', listener)
}

/**
 * Very simple node-like event emitter wrapper around EventTarget
 *
 * @todo add errors and promise rejections?
 */
export class EventEmitter<
  Events extends EventMap = EventMap,
  EventNames extends Extract<keyof Events, string> = Extract<
    keyof Events,
    string
  >,
> {
  #target = new EventTarget()
  #listeners = new Map<Fn, Fn>()

  on<E extends EventNames>(
    event: E | (Object & string),
    listener: (...args: Events[E]) => void,
    options?: AddEventListenerOptions,
  ) {
    const _listener = (event) => listener(...event.detail)
    this.#listeners.set(listener, _listener)
    this.#target.addEventListener(event, _listener, options)
    return () => this.#target.removeEventListener(event, _listener)
  }

  once<E extends EventNames>(
    event: E | (Object & string),
    listener: (...args: Events[E]) => void,
  ) {
    return this.on(event, listener, { once: true })
  }

  off(event: EventNames | (Object & string), listener: Fn) {
    const _listener = this.#listeners.get(listener)
    if (_listener) this.#target.removeEventListener(event, _listener)
  }

  emit<E extends EventNames | (Object & string)>(
    event: E,
    ...args: E extends EventEmitter ? Events[E] : any[]
  ) {
    return this.#target.dispatchEvent(new CustomEvent(event, { detail: args }))
  }
}

export const once = (ee: EventEmitter, event: string) =>
  new Promise((resolve) => ee.once(event, resolve))

type Fn = (...args: any[]) => any
