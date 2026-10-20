import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { extname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export type PreviewBuildRequest = {
  config: string
  outDir: string
  runtimes?: readonly string[]
}

export type PreviewBuildHandlers = { onSpawn?: (pid: number) => void }

const KILL_AFTER_MS = 5_000
const EXIT_POLL_MS = 50
const POSIX = process.platform !== 'win32'

// A shared inspector port would fail the build, and `--inspect-brk` would
// wait for a debugger nobody attaches.
const INSPECTOR_FLAG = /^--(?:inspect|debug)(?:-[a-z-]+)?(?:=|$)/
// The inspector options that also accept their value as the next argument.
const INSPECTOR_VALUE_FLAGS = new Set([
  '--inspect-port',
  '--debug-port',
  '--inspect-publish-uid',
])

/**
 * Builds the preview in a child process and settles only after that process
 * and everything it started have exited. Resolves false when the build was
 * cancelled; a failed build rejects, so stale output from an earlier preview
 * is never served.
 *
 * This module must stay free of build imports: the caller serves the preview
 * from its own process afterwards.
 */
export async function runPreviewBuild(
  request: PreviewBuildRequest,
  signal: AbortSignal,
  handlers: PreviewBuildHandlers = {},
): Promise<boolean> {
  if (signal.aborted) return false
  // Same extension as this module: sources under test, dist when installed.
  const entry = fileURLToPath(
    new URL(
      `./preview-build${extname(fileURLToPath(import.meta.url))}`,
      import.meta.url,
    ),
  )
  // Inherited flags keep loaders and conditions for config evaluation; the
  // trailing source-map flag wins over an inherited `--no-enable-source-maps`
  // so build errors point at sources.
  const execArgv = withoutInspectorFlags(process.execArgv)
  if (!process.versions.bun) execArgv.push('--enable-source-maps')
  const nodeOptions = process.env.NODE_OPTIONS
  const childNodeOptions =
    nodeOptions && withoutInspectorNodeOptions(nodeOptions)
  const child = spawn(
    process.execPath,
    [...execArgv, entry, JSON.stringify(request)],
    {
      stdio: ['ignore', 'inherit', 'inherit'],
      env:
        childNodeOptions === nodeOptions
          ? undefined
          : { ...process.env, NODE_OPTIONS: childNodeOptions },
      // Its own process group holds the helpers framework builders start,
      // so they can be stopped with the build without touching anything
      // else. A terminal interrupt no longer reaches the build directly;
      // the caller's signal handling cancels it.
      detached: POSIX,
    },
  )
  const exited = new Promise<{
    code: number | null
    signal: NodeJS.Signals | null
  }>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  if (child.pid !== undefined) handlers.onSpawn?.(child.pid)

  let stopping: Promise<void> | undefined
  const stop = () => (stopping ??= stopProcessTree(child))
  // The finally below reports a failure to stop.
  const cancel = () => void stop().catch(() => {})
  signal.addEventListener('abort', cancel, { once: true })
  let result: Awaited<typeof exited>
  try {
    result = await exited
  } finally {
    signal.removeEventListener('abort', cancel)
    // Once the build process is gone, nothing that is still running in its
    // group belongs to a build; clean up after success and failure alike.
    await stop()
  }

  if (signal.aborted) return false
  // Service managers may signal every process at once, and the build can
  // exit before this process observes its own signal.
  if (result.signal === 'SIGINT' || result.signal === 'SIGTERM') return false
  if (result.code === 0) return true
  throw new Error(
    `Neem preview build failed (${
      result.signal ? `signal ${result.signal}` : `exit code ${result.code}`
    }); the preview server was not started`,
  )
}

/**
 * Stops the build's process group: SIGTERM, then SIGKILL after a grace
 * period, settling once no process is left in it. The group outlives its
 * leader, so escalation keeps going after the build process itself exits.
 */
async function stopProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid
  if (pid === undefined) return
  if (!POSIX) {
    // No process groups: kill the tree while the build still roots it.
    if (child.exitCode === null && child.signalCode === null) {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' })
    }
    return
  }
  if (!signalGroup(pid, 'SIGTERM')) return
  for (const [timeout, next] of [
    [KILL_AFTER_MS, 'SIGKILL'],
    // SIGKILL cannot be ignored, but exits are asynchronous.
    [KILL_AFTER_MS, undefined],
  ] as const) {
    for (let waited = 0; waited < timeout; waited += EXIT_POLL_MS) {
      await sleep(EXIT_POLL_MS)
      if (!signalGroup(pid, 0)) return
    }
    if (next) signalGroup(pid, next)
  }
}

/** Signals a process group; false once the group no longer exists. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

export function withoutInspectorFlags(
  args: readonly string[],
  read: (arg: string) => string = (arg) => arg,
): string[] {
  const kept: string[] = []
  for (let index = 0; index < args.length; index++) {
    const arg = read(args[index]!)
    if (!INSPECTOR_FLAG.test(arg)) kept.push(args[index]!)
    else if (INSPECTOR_VALUE_FLAGS.has(arg)) index++
  }
  return kept
}

/**
 * NODE_OPTIONS separates options by spaces and may double-quote a value;
 * kept options are passed on verbatim.
 */
export function withoutInspectorNodeOptions(value: string): string {
  const options = value.match(/(?:[^\s"]+|"(?:\\.|[^"\\])*")+/g) ?? []
  const kept = withoutInspectorFlags(options, (option) =>
    option.replace(/"((?:\\.|[^"\\])*)"/g, (_, quoted: string) =>
      quoted.replace(/\\(.)/g, '$1'),
    ),
  )
  return kept.length === options.length ? value : kept.join(' ')
}
