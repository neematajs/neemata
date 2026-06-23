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
