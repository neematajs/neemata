import type { Callback } from '@nmtjs/common'

export type EventMap = { [K: string]: any[] }

type ListenerRegistration = {
  abortHandler?: () => void
  capture: boolean
  disposed: boolean
  event: string
  listener: Callback
  signal?: AbortSignal
  wrapper: EventListener
}

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
  #listeners = new Map<string, Map<Callback, Set<ListenerRegistration>>>()

  #addRegistration(registration: ListenerRegistration) {
    const events =
      this.#listeners.get(registration.event) ??
      new Map<Callback, Set<ListenerRegistration>>()

    if (!this.#listeners.has(registration.event)) {
      this.#listeners.set(registration.event, events)
    }

    const registrations =
      events.get(registration.listener) ?? new Set<ListenerRegistration>()

    if (!events.has(registration.listener)) {
      events.set(registration.listener, registrations)
    }

    registrations.add(registration)
  }

  #removeRegistration(registration: ListenerRegistration) {
    if (registration.disposed) return

    registration.disposed = true
    this.#target.removeEventListener(
      registration.event,
      registration.wrapper,
      registration.capture,
    )

    if (registration.signal && registration.abortHandler) {
      registration.signal.removeEventListener(
        'abort',
        registration.abortHandler,
      )
    }

    const events = this.#listeners.get(registration.event)
    const registrations = events?.get(registration.listener)

    registrations?.delete(registration)

    if (registrations?.size === 0) {
      events?.delete(registration.listener)
    }

    if (events?.size === 0) {
      this.#listeners.delete(registration.event)
    }
  }

  on<E extends EventName>(
    event: E | (Object & string),
    listener: (...args: Events[E]) => void,
    options?: AddEventListenerOptions,
  ) {
    const cleanup = () => {
      this.#removeRegistration(registration)
    }

    const registration: ListenerRegistration = {
      capture: !!options?.capture,
      disposed: false,
      event,
      listener,
      wrapper: (rawEvent) => {
        try {
          listener(...(rawEvent as CustomEvent<Events[E]>).detail)
        } finally {
          if (options?.once) {
            cleanup()
          }
        }
      },
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        return cleanup
      }

      registration.signal = options.signal
      registration.abortHandler = cleanup
      options.signal.addEventListener('abort', cleanup, { once: true })
    }

    this.#addRegistration(registration)
    this.#target.addEventListener(registration.event, registration.wrapper, {
      capture: options?.capture,
      passive: options?.passive,
    })

    return cleanup
  }

  once<E extends EventName>(
    event: E | (Object & string),
    listener: (...args: Events[E]) => void,
    options?: AddEventListenerOptions,
  ) {
    return this.on(event, listener, { ...options, once: true })
  }

  off(event: EventName | (Object & string), listener: Callback) {
    const registration = this.#listeners
      .get(event)
      ?.get(listener)
      ?.values()
      .next().value

    if (registration) {
      this.#removeRegistration(registration)
    }
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
    ee.once(
      event,
      ((...args: EventMap[EventName]) => {
        resolve(args)
      }) as (...args: any[]) => void,
      { signal },
    )
  })
}
