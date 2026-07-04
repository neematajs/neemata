import type { NeemRuntimeWorker } from '../shared/types.ts'

export const NeemRuntimeWorkerBrand = Symbol.for('neem:runtime-worker')

export function defineRuntimeWorker<Data = unknown, Definition = unknown>(
  worker: Omit<NeemRuntimeWorker<Data, Definition>, '_'>,
): NeemRuntimeWorker<Data, Definition> {
  // Copy before branding so the caller's object is not mutated or frozen.
  return Object.freeze({
    ...worker,
    [NeemRuntimeWorkerBrand]: true as const,
  })
}

export function isNeemRuntimeWorker(value: any): value is NeemRuntimeWorker {
  return (
    typeof value === 'object' &&
    value !== null &&
    value[NeemRuntimeWorkerBrand] === true
  )
}
