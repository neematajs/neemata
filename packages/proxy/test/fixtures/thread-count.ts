// Runs alone so no other proxy's runtime threads, or their collection, skew the count.
// Prints the proxy runtime's worker count and the count of default-named Tokio workers,
// which only a global runtime such as napi-rs's would start.
import { readdirSync, readFileSync } from 'node:fs'

import { Proxy } from '../../dist/index.js'

const threads = Number(process.argv[2])
const proxy = new Proxy({
  listen: '127.0.0.1:0',
  applications: [{ name: 'app', routing: { type: 'default' } }],
  threads,
})

// Thread names are truncated to 15 bytes in /proc.
const countThreads = (name: string) =>
  readdirSync('/proc/self/task').filter((task) => {
    try {
      return (
        readFileSync(`/proc/self/task/${task}/comm`, 'utf8').trim() === name
      )
    } catch {
      return false // the thread exited while listing
    }
  }).length

// Workers start and name themselves asynchronously after the runtime is built.
// Counted before start(), so blocking-pool threads, which share the name, don't show up.
const deadline = Date.now() + 2000
let count = countThreads('neemata-proxy')
while (count < threads && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10))
  count = countThreads('neemata-proxy')
}
const tokioDefault = countThreads('tokio-runtime-w')
await proxy.stop()
process.stdout.write(JSON.stringify({ proxy: count, tokioDefault }))
