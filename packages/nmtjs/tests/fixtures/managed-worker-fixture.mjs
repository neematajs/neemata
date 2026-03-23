import { workerData } from 'node:worker_threads'

workerData.vitePort?.on('message', (message) => {
  if (message?.event === 'ping') {
    workerData.vitePort.postMessage({ event: 'ack', data: message.data })
  }
})

workerData.port.on('message', (message) => {
  if (message?.type === 'stop') {
    process.exit(0)
  }
})

workerData.port.postMessage({ type: 'ready', data: { hosts: [] } })
