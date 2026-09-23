import type {
  NeemMode,
  NeemResolvedArtifact,
  NeemRuntimePlan,
  NeemRuntimeThreadHandle,
} from '../../shared/types.ts'
import type { ManifestLogger } from '../manifest/manifest.ts'
import type { NoParams } from '../rpc.ts'
import type { SerializedError } from '../utils.ts'

export type HostRunnerData = {
  mode: NeemMode
  runtimeName: string
  hostArtifact: NeemResolvedArtifact
  plannerArtifact: NeemResolvedArtifact
  outDir: string
  logger?: ManifestLogger
}

/**
 * Commands a host runner serves. `plan` and `start` each run one at a time,
 * so a repeated request cannot create a second host; `stop` and `shutdown`
 * may overlap anything, since stopping must reach a host still being created.
 */
export type HostRunnerCommands = {
  plan: { params: NoParams; result: NeemRuntimePlan }
  start: {
    params: { threads: readonly NeemRuntimeThreadHandle[] }
    result: void
  }
  stop: { params: NoParams; result: void }
  shutdown: { params: NoParams; result: void }
}

export const HOST_RUNNER_SERIAL_COMMANDS = [
  'plan',
  'start',
] as const satisfies readonly (keyof HostRunnerCommands)[]

export type HostRunnerEvent =
  | { type: 'ready' }
  | { type: 'failure'; error: SerializedError }
