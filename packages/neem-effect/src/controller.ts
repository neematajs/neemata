import type { WorkerUpdateBatch } from '@nmtjs/neem/internal/build/updates'
import type { NeemHostController } from '@nmtjs/neem/internal/flavor'
import type { HostControllerOptions } from '@nmtjs/neem/internal/host/controller'
import type { OperationScope } from '@nmtjs/neem/internal/host/lifecycle'
import type { RuntimePatchResult } from '@nmtjs/neem/internal/host/runtime'
import type { RuntimeSnapshot } from '@nmtjs/neem/internal/manifest/snapshot'
import type {
  NeemRuntimeServerHealth,
  NeemRuntimeServerSnapshot,
  NeemRuntimeUpstream,
} from '@nmtjs/neem/internal/shared/types'

import { lifecycleOf } from './internal/context.ts'
import { Host } from './internal/host.ts'
import { Deadline } from './internal/lifetime.ts'
import { runPromise } from './internal/run.ts'

/**
 * The Promise surface the shared dev session drives. Operations interrupted by
 * a stop reject with `OperationAbortedError`.
 */
export class EffectHostController implements NeemHostController {
  private readonly host: Host
  private snapshot: RuntimeSnapshot

  constructor(options: HostControllerOptions) {
    this.host = new Host(options)
    this.snapshot = options.snapshot
  }

  start(): Promise<void> {
    return runPromise(this.host.start())
  }

  reload(snapshot: RuntimeSnapshot): Promise<void> {
    this.snapshot = snapshot
    return runPromise(this.host.reload(snapshot))
  }

  reloadRuntime(runtimeName: string, snapshot: RuntimeSnapshot): Promise<void> {
    this.snapshot = snapshot
    return runPromise(this.host.reloadRuntime(runtimeName, snapshot))
  }

  applyPatch(
    runtimeName: string,
    updates: WorkerUpdateBatch,
  ): Promise<RuntimePatchResult> {
    return runPromise(this.host.applyPatch(runtimeName, updates))
  }

  /** Only the deadline of a caller's scope is used: one budget for the whole stop. */
  stop(scope?: OperationScope): Promise<void> {
    const deadline =
      scope?.deadline === undefined
        ? Deadline.after(lifecycleOf(this.snapshot).stopTimeout)
        : Deadline.after(scope.remaining())
    return runPromise(this.host.stop(deadline))
  }

  getSnapshot(): NeemRuntimeServerSnapshot {
    return this.host.getSnapshot()
  }

  getHealth(): NeemRuntimeServerHealth {
    return this.host.getHealth()
  }

  getUpstreams(): readonly NeemRuntimeUpstream[] {
    return this.host.getUpstreams()
  }
}
