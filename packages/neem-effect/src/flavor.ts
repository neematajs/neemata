import { fileURLToPath } from 'node:url'

import type { NeemHostFlavor } from '@nmtjs/neem/internal/flavor'
import * as Effect from 'effect/Effect'

import { runHostUntilClosed } from './bootstrap.ts'
import { EffectHostController } from './controller.ts'
import { loadEnvFiles } from './internal/env-files.ts'
import { FLAVOR_NAME } from './internal/flavor-name.ts'
import { loadSnapshot } from './internal/snapshot.ts'

// Source when run from the repository, the build output when installed.
const extension = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
const entry = (path: string) =>
  fileURLToPath(new URL(`${path}${extension}`, import.meta.url))

/** Builds bundle these entries; `dev` and `start` run this host. */
export const neemEffectFlavor: NeemHostFlavor = {
  name: FLAVOR_NAME,
  entries: {
    worker: entry('./worker/entry'),
    runner: entry('./runner/entry'),
    start: entry('./standalone/entry'),
  },
  loadEnvFiles: (paths) => Effect.runPromise(loadEnvFiles(paths)),
  loadSnapshot: (options) => Effect.runPromise(loadSnapshot(options)),
  createController: (options) => new EffectHostController(options),
  runHostUntilClosed,
}
