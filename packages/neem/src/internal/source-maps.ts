import { getEnvironmentData, setEnvironmentData } from 'node:worker_threads'

const KEY = 'neem:source-maps'
const FLAG = /^--(no-)?enable-source-maps$/

// Bun applies its own source maps and reports no `process.sourceMapsEnabled`.
const supported = !process.versions.bun

/**
 * The user's own `--enable-source-maps` or `--no-enable-source-maps`, if
 * any. As in Node, the command line wins over `NODE_OPTIONS`, and the last
 * flag wins within each.
 */
export function sourceMapsFlag(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env.NODE_OPTIONS,
): boolean | undefined {
  return (
    lastFlag(execArgv) ??
    lastFlag(splitNodeOptions(nodeOptions ?? '').map(unquoteNodeOption))
  )
}

/** `NODE_OPTIONS` split as Node does: whitespace outside double quotes. */
export function splitNodeOptions(value: string): string[] {
  return value.match(/(?:[^\s"]+|"(?:\\.|[^"\\])*")+/g) ?? []
}

/** An option with its double quotes and their backslash escapes removed. */
export function unquoteNodeOption(option: string): string {
  return option.replace(/"((?:\\.|[^"\\])*)"/g, (_, quoted: string) =>
    quoted.replace(/\\(.)/g, '$1'),
  )
}

function lastFlag(args: readonly string[]): boolean | undefined {
  for (let index = args.length - 1; index >= 0; index--) {
    // Node accepts underscores in option names and ignores a value on this
    // flag: only the `no-` prefix decides.
    const name = args[index]!.split('=', 1)[0]!.replaceAll('_', '-')
    const match = FLAG.exec(name)
    if (match) return match[1] === undefined
  }
  return undefined
}

/**
 * Source maps are on by default for the commands that run code for
 * debugging (`dev`, `preview`), unless the user turned them off with a Node
 * flag; `start` leaves Node's own default (off) or the user's flag alone.
 *
 * Enables Node source maps in this thread and in every Neem worker spawned
 * afterwards. Workers copy the startup flags, not
 * `process.setSourceMapsEnabled`, and rejecting V8 flags such as
 * `--expose-gc` rules out passing `execArgv`; environment data reaches them
 * instead. Returns a function that restores the previous state.
 */
export function enableDefaultSourceMaps(): () => void {
  if (!supported || sourceMapsFlag() === false) return () => {}
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
 * Applies `enableDefaultSourceMaps` from the spawning thread. Worker entries
 * call this before loading user code: Node reads a module's map only if
 * source maps are enabled when the module loads.
 */
export function inheritSourceMaps(): void {
  if (supported && getEnvironmentData(KEY) === true) {
    process.setSourceMapsEnabled(true)
  }
}
