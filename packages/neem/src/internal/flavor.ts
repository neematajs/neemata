import type {
  LoadRuntimeSnapshotOptions,
  RunHostOptions,
} from './host/bootstrap.ts'
import type {
  HostController,
  HostControllerOptions,
} from './host/controller.ts'
import type { RuntimeSnapshot } from './manifest/snapshot.ts'

/** Serializable build selection, also sent to the isolated dev watcher. */
export type NeemBuildFlavor = {
  name: string
  entries: { worker: string; runner: string; start: string }
}

/** The dev builder needs these operations, not a particular host implementation. */
export type NeemHostController = Pick<
  HostController,
  | 'start'
  | 'stop'
  | 'reload'
  | 'reloadRuntime'
  | 'applyPatch'
  | 'getSnapshot'
  | 'getHealth'
  | 'getUpstreams'
>

export type NeemHostFlavor = NeemBuildFlavor & {
  loadSnapshot?: (
    options: LoadRuntimeSnapshotOptions,
  ) => Promise<RuntimeSnapshot>
  loadEnvFiles?: (paths: readonly string[]) => Promise<void>
  createController: (options: HostControllerOptions) => NeemHostController
  runHostUntilClosed: (
    snapshot: RuntimeSnapshot,
    options: RunHostOptions,
  ) => Promise<void>
}

export function buildFlavor(
  flavor: NeemBuildFlavor | undefined,
): NeemBuildFlavor | undefined {
  // Functions cannot be structured-cloned into the watcher thread.
  return flavor && { name: flavor.name, entries: flavor.entries }
}
