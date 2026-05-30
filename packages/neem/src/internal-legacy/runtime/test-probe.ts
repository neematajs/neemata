import type { NeemHostHookEvent, NeemHostHooks } from './hooks.ts'
import { createNeemHostHooks } from './hooks.ts'

export type NeemTestProbe = {
  hooks: NeemHostHooks
  emit: (event: string, data?: Record<string, unknown>) => void
}

export function createNeemTestProbe(): NeemTestProbe | undefined {
  if (process.env.NEEM_TEST_PROBE !== '1') return undefined
  if (typeof process.send !== 'function') return undefined

  const hooks = createNeemHostHooks()
  const probe: NeemTestProbe = { hooks, emit }

  for (const name of [
    'server:start',
    'server:ready',
    'server:reload',
    'server:stop',
    'server:fail',
    'runtime:start',
    'runtime:ready',
    'runtime:reload',
    'runtime:stop',
    'runtime:fail',
    'worker:start',
    'worker:ready',
    'worker:stop',
    'worker:fail',
  ] as const) {
    hooks.hook(name, (event) => {
      emit(`hook:${name}`, normalizeHookEvent(event))
    })
  }

  return probe
}

function emit(event: string, data: Record<string, unknown> = {}): void {
  process.send?.({ source: 'neem:test-probe', event, ...data })
}

function normalizeHookEvent(
  event: NeemHostHookEvent & Record<string, unknown>,
) {
  return {
    ...event,
    error: event.error
      ? {
          name: event.error.name,
          message: event.error.message,
          stack: event.error.stack,
        }
      : undefined,
  }
}
