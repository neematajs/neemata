/**
 * The layout of a built Neem output directory. The build graph writes
 * artifacts into it, the manifest records paths relative to its root, and
 * `cleanNeemOutDir` removes exactly these entries — they must stay in step.
 */
export const MANIFEST_FILE = 'neem.manifest.json'

export const DEFAULT_CONFIG_FILE = 'neem.config.ts'
export const DEFAULT_OUT_DIR = 'dist'
export const DEFAULT_DEV_OUT_DIR = '.neem'

export const OUT_LAYOUT = {
  /** Infra entries and per-runtime artifact directories. */
  runtime: 'runtime',
  /** Generated per-runtime production start entries. */
  runtimeStarts: 'runtimes',
  /** Compiled config-owned artifacts. */
  config: 'config',
  plugins: 'config/plugins',
  logger: 'config/logger',
  /** Start entry emitted next to the manifest, and its runtime counterpart. */
  startEntry: 'start.js',
  runtimeStartEntry: 'runtime/start.js',
} as const
