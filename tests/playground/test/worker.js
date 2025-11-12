import { isMainThread, parentPort } from 'node:worker_threads'

const callOffset = Uint32Array.BYTES_PER_ELEMENT

export function transform(payload) {
  try {
    return Buffer.from(
      JSON.stringify(JSON.parse(payload.toString('utf-8'))),
      'utf8',
    )
  } catch (error) {
    throw new Error('Invalid JSON')
  }

  // return Buffer.from(payload.toString('utf-8'))
}

if (!isMainThread) {
  parentPort.on('message', (msg) => {
    const buff = Buffer.from(msg)
    const call = buff.readUint32LE(0)
    const payload = transform(buff.subarray(callOffset))
    const shared = new SharedArrayBuffer(callOffset + payload.length)
    const sharedBuffer = Buffer.from(shared)
    sharedBuffer.writeUint32LE(call, 0)
    sharedBuffer.set(payload, callOffset)
    parentPort.postMessage(shared)
  })

  console.log('Worker is online')
}
