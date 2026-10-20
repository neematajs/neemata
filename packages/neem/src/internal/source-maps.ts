import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads'

const KEY = 'neem:source-maps'

// Bun applies its own source maps and reports no `process.sourceMapsEnabled`.
const supported = !process.versions.bun

/**
 * Enables Node source maps in this thread and in every Neem worker spawned
 * afterwards, whatever flags Node started with. Workers copy the startup
 * flags, not `process.setSourceMapsEnabled`, and rejecting V8 flags such as
 * `--expose-gc` rules out passing `execArgv`; environment data reaches them
 * instead. Returns a function that restores the previous state.
 */
export function enableSourceMaps(): () => void {
  if (!supported) return () => {}
  const enabled = process.sourceMapsEnabled
  const inherited = getEnvironmentData(KEY)
  process.setSourceMapsEnabled(true)
  setEnvironmentData(KEY, true)
  return () => {
    setEnvironmentData(KEY, inherited as boolean | undefined)
    process.setSourceMapsEnabled(enabled)
  }
}

/**
 * Applies `enableSourceMaps` from the spawning thread. Worker entries call
 * this before loading user code: Node reads a module's map only if source
 * maps are enabled when the module loads.
 */
export function inheritSourceMaps(): void {
  if (supported && getEnvironmentData(KEY) === true) {
    process.setSourceMapsEnabled(true)
  }
}
