import { isBuiltin } from 'node:module'

import type { MaybePromise } from '@nmtjs/common'
import { createFuture } from '@nmtjs/common'
import * as rolldown from 'rolldown'

export type ConfigSignalWatcher = rolldown.RolldownWatcher

export type ConfigSignalWatchOptions = {
  files: readonly string[]
  onInvalidated: () => MaybePromise<void>
  tolerateInitialError?: boolean
}

// Deliberate exception to the "no Rolldown watchers in the CLI main thread"
// rule: this watcher must outlive WatcherService teardown, because a broken
// config kills the service and something has to keep watching config files to
// retry. skipWrite keeps it output-free, and it is closed and recreated on
// every watcher replacement to contain Rolldown watcher resource retention.
export async function watchConfigSignal({
  files,
  onInvalidated,
  tolerateInitialError = false,
}: ConfigSignalWatchOptions): Promise<ConfigSignalWatcher> {
  const watcher = rolldown.watch({
    input: [...files],
    platform: 'node',
    logLevel: 'warn',
    external: (id) => isBuiltin(id),
    output: { minify: false, sourcemap: false },
    experimental: { chunkOptimization: false },
    optimization: { inlineConst: false, pifeForModuleWrappers: false },
    treeshake: false,
    watch: {
      buildDelay: 100,
      clearScreen: false,
      skipWrite: true,
      exclude: 'node_modules/**',
      watcher: { debounceDelay: 50, useDebounce: true },
    },
  })
  const ready = createFuture<void>()
  let initial = true

  watcher.on('event', async (event) => {
    if (event.code === 'BUNDLE_END' && 'result' in event) {
      await event.result?.close?.()
      return
    }

    if (event.code === 'ERROR') {
      if ('result' in event) await event.result?.close?.()
      if (initial) {
        initial = false
        if (tolerateInitialError) ready.resolve()
        else ready.reject(event.error)
        return
      }
      void onInvalidated()
      return
    }

    if (event.code !== 'END') return
    if (initial) {
      initial = false
      ready.resolve()
      return
    }
    void onInvalidated()
  })

  await ready.promise
  return watcher
}
