import type { WorkerServiceStopProgressEvent } from './services/client.ts'
import type { RuntimeEvent, WatcherEvent } from './services/protocol.ts'

export type NeemTestProbeEvent =
  | `cli:${'build' | 'dev' | 'start'}:${'start' | 'closed'}`
  | `runtime:${RuntimeEvent['type']}`
  | `watcher:${WatcherEvent['type']}`
  | `service:stop-${WorkerServiceStopProgressEvent['phase']}`

export type NeemTestProbe = {
  emit: (event: NeemTestProbeEvent, data?: Record<string, unknown>) => void
}

export function createNeemTestProbe(): NeemTestProbe | undefined {
  if (process.env.NEEM_TEST_PROBE !== '1') return undefined
  if (typeof process.send !== 'function') return undefined

  return { emit }
}

function emit(
  event: NeemTestProbeEvent,
  data: Record<string, unknown> = {},
): void {
  process.send?.({ source: 'neem:test-probe', event, ...data })
}
