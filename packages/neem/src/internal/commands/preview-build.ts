import type { PreviewBuildRequest } from './preview.ts'
import { buildNeem } from './build.ts'

// Entry of the short-lived process that runs a preview build. Rolldown and
// framework builders keep native threads and hundreds of MiB after a build,
// even in a worker thread that has exited; only process exit returns them, so
// the process that serves the preview never loads them.
const request = JSON.parse(process.argv[2] ?? '') as PreviewBuildRequest

try {
  await buildNeem({ ...request, command: 'preview' })
} catch (error) {
  console.error(error)
  process.exit(1)
}
// Builders may leave handles open; the parent serves only after true exit.
process.exit(0)
