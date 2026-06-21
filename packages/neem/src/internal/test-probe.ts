export type NeemTestProbe = {
  emit: (event: string, data?: Record<string, unknown>) => void
}

export function createNeemTestProbe(): NeemTestProbe | undefined {
  if (process.env.NEEM_TEST_PROBE !== '1') return undefined
  if (typeof process.send !== 'function') return undefined

  return { emit }
}

function emit(event: string, data: Record<string, unknown> = {}): void {
  process.send?.({ source: 'neem:test-probe', event, ...data })
}
