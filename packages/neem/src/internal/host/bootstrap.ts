import type { Logger } from 'pino'
import * as Effect from 'effect/Effect'

import type { NeemMode } from '../../shared/types.ts'
import { loadSnapshot } from '../snapshot.ts'
export { runHostUntilClosed } from '../../bootstrap.ts'
export type { RunHostOptions } from '../../bootstrap.ts'
export type LoadRuntimeSnapshotOptions = {
  mode: NeemMode
  outDir: string
  manifestFile: string
  env?: NodeJS.ProcessEnv
  runtimes?: readonly string[]
  // Dev sessions resolve the logger once per host generation and reuse it for
  // runtime reloads, so a reload does not re-import the logger module.
  logger?: Logger
}

export const loadRuntimeSnapshot = (options: LoadRuntimeSnapshotOptions) =>
  Effect.runPromise(loadSnapshot(options))
