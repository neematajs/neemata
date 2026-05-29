import { describe, expectTypeOf, it } from 'vitest'

import type { NeemManagedWorker } from '../../../packages/neem/src/internal/runtime/managed-worker.ts'
import type {
  NeemNativeProxy,
  NeemProxyManager,
} from '../../../packages/neem/src/internal/runtime/proxy.ts'
import type { NeemProxyUpstreamRegistry } from '../../../packages/neem/src/internal/runtime/proxy-upstreams.ts'
import type { NeemStartedRuntimeThread } from '../../../packages/neem/src/internal/runtime/runtime.ts'
import type { NeemRuntimeServer } from '../../../packages/neem/src/internal/runtime/server.ts'
import type {
  NeemPoolWorker,
  NeemWorkerPool,
} from '../../../packages/neem/src/internal/runtime/worker-pool.ts'
import type {
  NeemManagedWorkerHealth,
  NeemProxyHealth,
  NeemProxyUpstream,
  NeemProxyUpstreamSnapshot,
  NeemRuntimeServerHealth,
  NeemRuntimeServerRuntimeHealth,
  NeemRuntimeServerSnapshot,
  NeemRuntimeServerState,
  NeemStartedRuntimeThreadHealth,
  NeemWorkerPoolHealth,
  NeemWorkerPoolState,
} from '../../../packages/neem/src/public/runtime.ts'

type IterableValue<T> = T extends IterableIterator<infer Value> ? Value : never

describe('runtime public DTO exports', () => {
  it('keeps runtime DTO surfaces aligned with public runtime DTOs', () => {
    expectTypeOf<
      ReturnType<NeemRuntimeServer['getState']>
    >().toEqualTypeOf<NeemRuntimeServerState>()
    expectTypeOf<
      ReturnType<NeemRuntimeServer['getSnapshot']>
    >().toEqualTypeOf<NeemRuntimeServerSnapshot>()
    expectTypeOf<
      ReturnType<NeemRuntimeServer['getHealth']>
    >().toEqualTypeOf<NeemRuntimeServerHealth>()
    expectTypeOf<
      NeemRuntimeServerHealth['runtimes'][number]
    >().toEqualTypeOf<NeemRuntimeServerRuntimeHealth>()
    expectTypeOf<
      ReturnType<NeemWorkerPool<NeemPoolWorker>['getState']>
    >().toEqualTypeOf<NeemWorkerPoolState>()
    expectTypeOf<
      ReturnType<NeemWorkerPool<NeemPoolWorker>['getHealth']>
    >().toEqualTypeOf<NeemWorkerPoolHealth>()
    expectTypeOf<
      ReturnType<NeemManagedWorker['getHealth']>
    >().toEqualTypeOf<NeemManagedWorkerHealth>()
    expectTypeOf<
      ReturnType<NeemStartedRuntimeThread['getHealth']>
    >().toEqualTypeOf<NeemStartedRuntimeThreadHealth>()
    expectTypeOf<
      Parameters<NeemNativeProxy['addUpstream']>[1]
    >().toEqualTypeOf<NeemProxyUpstream>()
    expectTypeOf<
      IterableValue<ReturnType<NeemProxyUpstreamRegistry['list']>>
    >().toEqualTypeOf<NeemProxyUpstreamSnapshot>()
    expectTypeOf<
      ReturnType<NeemProxyManager['getHealth']>
    >().toEqualTypeOf<NeemProxyHealth>()
  })
})
