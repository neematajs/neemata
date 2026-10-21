import { setTimeout as sleep } from 'node:timers/promises'

import type { PreviewBuildRequest } from './preview.ts'

const FLUSH_TIMEOUT_MS = 2_000
const FLUSH_POLL_MS = 10

// Entry of the short-lived process that runs a preview build. Rolldown and
// framework builders keep native threads and hundreds of MiB after a build,
// even in a worker thread that has exited; only process exit returns them, so
// the process that serves the preview never loads them.
const request = JSON.parse(process.argv[2] ?? '') as PreviewBuildRequest

// The parent holds the other end of the IPC channel, so it disconnects when
// the parent is gone, however it died; its own cleanup cannot stop the build
// then. Set up before the compiler loads, and only while this process lives:
// helpers left behind after it exited are the parent's to stop. On POSIX this
// process leads the group that holds the builders' helpers; elsewhere there
// is no group and only this process exits.
const parentLost = () => {
  if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL')
  process.exit(1)
}
process.once('disconnect', parentLost)
// Node does not repeat a disconnect that happened while this module loaded.
if (!process.connected) parentLost()

const { buildNeem } = await import('./build.ts')
let code = 0
try {
  await buildNeem({ ...request, command: 'preview' })
} catch (error) {
  console.error(error)
  code = 1
}
// Builders may leave handles open; the parent serves only after true exit.
// The output is inherited, and `process.exit` drops what a pipe has not
// taken yet. A reader that stops reading only delays the exit.
if (process.versions.bun) {
  // Bun reports nothing pending; ending the streams waits for their writes.
  // A handle a builder left behind may still write; that write, like any
  // other stream error now, only fails output that cannot be delivered, and
  // is not raised to a handler that would exit before the rest is written.
  await Promise.race([
    Promise.all(
      [process.stdout, process.stderr].map((stream) => {
        stream.on('error', () => {})
        return new Promise<void>((resolve) => stream.end(resolve))
      }),
    ),
    sleep(FLUSH_TIMEOUT_MS),
  ])
} else {
  // Pending bytes are read from the stream state: framework loggers replace
  // `write` and drop its callback.
  const flushedBy = Date.now() + FLUSH_TIMEOUT_MS
  while (
    (process.stdout.writableLength > 0 || process.stderr.writableLength > 0) &&
    Date.now() < flushedBy
  ) {
    await sleep(FLUSH_POLL_MS)
  }
}
process.exit(code)
