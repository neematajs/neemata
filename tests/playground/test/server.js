import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { transform } from './worker.js'

let _callId = 0
const callOffset = Uint32Array.BYTES_PER_ELEMENT

const data = (res) => {
  return new Promise((resolve) => {
    const chunks = []
    res.onData((chunk, isLast) => {
      const copy = Buffer.allocUnsafe(chunk.byteLength)
      copy.set(new Uint8Array(chunk))
      chunks.push(copy)
      if (isLast) {
        resolve(Buffer.concat(chunks))
      }
    })
  })
}

const workers = Array.from(
  { length: Number(process.argv[2]) },
  () => new Worker(fileURLToPath(import.meta.resolve('./worker.js'))),
)

await Promise.all(workers.map((worker) => once(worker, 'online')))

let _workerIndex = 0

const calls = {}

for (const worker of workers) {
  worker.on('message', (msg) => {
    const buff = Buffer.from(msg)
    const call = buff.readUint32LE(0)
    const body = buff.subarray(callOffset)
    calls[call](body)
    delete calls[call]
  })
}

function callWorker(callId, payload) {
  const { resolve, promise } = Promise.withResolvers()
  calls[callId] = resolve
  const workerIndex = _workerIndex++
  if (workerIndex >= workers.length - 1) _workerIndex = 0
  const worker = workers[workerIndex]
  worker.postMessage(payload)
  return promise
}

async function handle(body) {
  let response

  if (workers.length !== 0) {
    const callId = ++_callId
    const shared = new SharedArrayBuffer(callOffset + body.length)
    const sharedBuffer = Buffer.from(shared)
    sharedBuffer.writeUint32LE(callId, 0)
    sharedBuffer.set(body, callOffset)
    response = await callWorker(callId, shared)
  } else {
    response = transform(body)
  }

  return response
}

if (globalThis.Bun) {
  Bun.serve({
    port: 3030,
    fetch: async (req) => {
      const body = Buffer.from(await req.arrayBuffer())
      const response = await handle(body)
      return new Response(response, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      })
    },
  })
} else {
  const { App } = await import('uWebSockets.js')
  App({})
    .any('*', (res) => {
      console.log('Received request on any route')
      res.endWithoutBody()
    })
    .post('*', async (res) => {
      const ab = new AbortController()
      res.onAborted(() => ab.abort())
      const body = await data(res)
      const response = await handle(body)
      if (ab.signal.aborted) return
      res.cork(() => {
        res.writeStatus('200 OK')
        res.writeHeader('Content-Type', 'text/plain')
        res.end(response)
      })
    })
    .listen('127.0.0.1', 3030, () => {
      console.log(`Server is listening (PID ${process.pid})`)
    })
}

function fmMem(val) {
  return (val / 1024 / 1024).toFixed(0) + ' MB'
}

setInterval(() => {
  const { arrayBuffers, external, heapTotal, heapUsed, rss } =
    process.memoryUsage()
  globalThis.gc?.()
  // pretty print memory usage
  console.log(
    // `RSS: ${(rss / 1024 / 1024).toFixed(0)} MB, HT: ${(heapTotal / 1024 / 1024).toFixed(0)} MB, HU: ${(heapUsed / 1024 / 1024).toFixed(0)} MB, E: ${(external / 1024 / 1024).toFixed(0)} MB, AB: ${(arrayBuffers / 1024 / 1024).toFixed(0)} MB`,
    `RSS: ${fmMem(rss)}, HeapT: ${fmMem(heapTotal)}, HeapU: ${fmMem(heapUsed)}, Ext: ${fmMem(external)}, ArrBufs: ${fmMem(arrayBuffers)}`,
  )
}, 5000)
