import { parentPort, workerData } from 'node:worker_threads'

if (!parentPort) {
  throw new Error('managed worker fixture requires parent port')
}

const timers = new Set()

function keepAlive() {
  const timer = setInterval(() => {}, 1_000)
  timers.add(timer)
}

function stop() {
  for (const timer of timers) clearInterval(timer)
  timers.clear()
  parentPort.postMessage({ type: 'stopped' })
  parentPort.close()
}

parentPort.on('message', (message) => {
  if (message?.type !== 'stop') return
  if (workerData.ignoreStop) return
  stop()
})

if (workerData.mode === 'ready' || workerData.mode === 'fail-after-ready') {
  parentPort.postMessage({ type: 'ready' })
}

if (workerData.mode === 'fail-after-ready') {
  setTimeout(() => {
    throw new Error('managed worker fixture failure')
  }, 20)
}

keepAlive()
