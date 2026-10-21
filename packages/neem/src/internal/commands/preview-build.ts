import type { PreviewBuildRequest } from './preview.ts'

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
try {
  await buildNeem({ ...request, command: 'preview' })
} catch (error) {
  console.error(error)
  process.exit(1)
}
// Builders may leave handles open; the parent serves only after true exit.
process.exit(0)
