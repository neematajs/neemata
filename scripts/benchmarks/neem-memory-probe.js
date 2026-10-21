import { isMainThread } from 'node:worker_threads'

// CPU and RSS cover the whole process, including every worker. Summing RSS
// reported by workers would count the same resident pages repeatedly.
if (isMainThread && process.send) {
  const sample = (source) => ({
    source,
    runtimeVersion: process.versions.bun ?? process.version,
    rss: process.memoryUsage.rss(),
    cpu: process.cpuUsage(),
    maxRss: process.resourceUsage().maxRSS * 1024,
  })
  process.on('message', (message) => {
    if (message !== 'neem:measure') return
    process.send(sample('neem:measure'))
  })
  // Build exits naturally; capture its process-wide high-water mark before
  // IPC closes, without holding the completed compiler open for measurement.
  process.once('beforeExit', () => process.send(sample('neem:final')))
  process.channel.unref()
}
