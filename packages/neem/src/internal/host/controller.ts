import type { HostOptions } from '../host.ts'
export type HostControllerOptions = HostOptions
import type {
  NeemRuntimeServerHealth,
  NeemRuntimeServerSnapshot,
  NeemRuntimeUpstream,
} from '../../shared/types.ts'
import type { WorkerUpdateBatch } from '../build/updates.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { RuntimePatchResult } from '../runtime.ts'
import type { OperationScope } from './lifecycle.ts'
import { lifecycleOf } from '../context.ts'
import { Host } from '../host.ts'
import { Deadline } from '../lifetime.ts'
import { runPromise } from '../run.ts'

/**
 * The Promise surface the shared dev session drives. Operations interrupted by
 * a stop reject with `OperationAbortedError`.
 */
export class HostController {
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
