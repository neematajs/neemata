import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import {
  sourceMapsFlag,
  splitNodeOptions,
  unquoteNodeOption,
} from '../source-maps.ts'

export type PreviewBuildRequest = {
  config: string
  outDir: string
  runtimes?: readonly string[]
}

export type PreviewBuildHandlers = { onSpawn?: (pid: number) => void }

const KILL_AFTER_MS = 5_000
const EXIT_POLL_MS = 50
const POSIX = process.platform !== 'win32'
const PID_ENTRY = /^\d+$/

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
  // Inherited flags keep loaders and conditions for config evaluation, and
  // the user's own source-map flag; without one, build errors point at
  // sources as in the rest of preview.
  const execArgv = withoutInspectorFlags(process.execArgv)
  if (!process.versions.bun && sourceMapsFlag() === undefined) {
    execArgv.push('--enable-source-maps')
  }
  const nodeOptions = process.env.NODE_OPTIONS
  const childNodeOptions =
    nodeOptions && withoutInspectorNodeOptions(nodeOptions)
  const child = spawn(
    process.execPath,
    [...execArgv, entry, JSON.stringify(request)],
    {
      // The IPC channel carries no messages: a running build stops itself
      // and its group once it disconnects, however this process died. Stdin
      // stays ignored, so builders and helpers reading it see its end.
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
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
 * period, settling once no process in it can run. The group outlives its
 * leader, so escalation keeps going after the build process itself exits.
 * Rejects when a member survives SIGKILL, so nothing is served next to it.
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
  // `kill` still finds a member that exited but was never reaped: orphans go
  // to PID 1, and a container's PID 1 may never wait for them. Linux lists
  // those zombies in procfs; elsewhere PID 1 reaps, so the group must empty.
  const hasRunningMember =
    process.platform === 'linux'
      ? groupMemberProbe(pid)
      : () => Promise.resolve(true)
  const settle = async (): Promise<'gone' | 'idle' | 'running'> => {
    for (let waited = 0; waited < KILL_AFTER_MS; waited += EXIT_POLL_MS) {
      await sleep(EXIT_POLL_MS)
      if (!signalGroup(pid, 0)) return 'gone'
      if (!(await hasRunningMember())) return 'idle'
    }
    return 'running'
  }
  if ((await settle()) === 'gone') return
  // Only zombies are left, or the grace period ran out. A scan can miss a
  // process forked while it ran; after SIGKILL the group cannot grow, so the
  // scans that follow are final.
  signalGroup(pid, 'SIGKILL')
  // SIGKILL cannot be ignored, but exits are asynchronous.
  if ((await settle()) === 'running') {
    throw new Error(
      `Neem preview build left processes running in process group ${pid}`,
    )
  }
}

/**
 * Returns a check for whether a Linux process group still has a member that
 * is not a zombie. Anything procfs does not answer for certain counts as
 * running, so a failed read can only delay the stop or fail it.
 */
export function groupMemberProbe(
  pgid: number,
  procRoot = '/proc',
): () => Promise<boolean> {
  // A member found running usually stays so for several polls; checking it
  // first spares rescanning every process until it exits.
  let running: string | undefined
  const mayRun = async (entry: string) => {
    let stat: string
    try {
      stat = await readFile(join(procRoot, entry, 'stat'), 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // Reaped since the listing.
      return code !== 'ENOENT' && code !== 'ESRCH'
    }
    // `pid (comm) state ppid pgrp ...`; comm may hold spaces and parentheses.
    const close = stat.lastIndexOf(')')
    const [state, , pgrp] = stat.slice(close + 2).split(' ')
    if (close === -1 || !state || !PID_ENTRY.test(pgrp ?? '')) return true
    return Number(pgrp) === pgid && state !== 'Z' && state !== 'X'
  }
  return async () => {
    if (running !== undefined && (await mayRun(running))) return true
    running = undefined
    let entries: string[]
    try {
      entries = await readdir(procRoot)
    } catch {
      return true
    }
    for (const entry of entries) {
      if (PID_ENTRY.test(entry) && (await mayRun(entry))) {
        running = entry
        return true
      }
    }
    return false
  }
}

/** Signals a process group; false once the group no longer exists. */
function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    // macOS refuses to signal a group whose members are all zombies, until
    // launchd reaps them. The group still exists: the callers keep polling,
    // and fail if it outlasts their grace periods.
    if (code === 'EPERM' && process.platform === 'darwin') return true
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
  const options = splitNodeOptions(value)
  const kept = withoutInspectorFlags(options, unquoteNodeOption)
  return kept.length === options.length ? value : kept.join(' ')
}
