import type { MessagePort, WorkerOptions } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import EventEmitter, { once } from 'node:events'
import { MessageChannel, Worker } from 'node:worker_threads'

import type {
  JobTaskResult,
  ServerPortMessage,
  ThreadPortMessage,
  WorkerJobTask,
} from './types.ts'

export type ThreadState =
  | 'starting'
  | 'error'
  | 'terminating'
  | 'pending'
  | 'ready'

export class Thread extends EventEmitter<
  {
    error: [error: Error]
    ready: [undefined]
    task: [{ id: string; data: JobTaskResult }]
    terminate: []
  } & {
    [K in `task-${string}`]: [data: unknown]
  }
> {
  worker: Worker
  state: ThreadState = 'pending'

  constructor(
    readonly port: MessagePort,
    workerPath: string,
    workerOptions: WorkerOptions,
  ) {
    super()
    this.worker = new Worker(workerPath, workerOptions)
    this.port.on('message', (msg: ServerPortMessage) => {
      this.emit(msg.type, msg.data)
      if (msg.type === 'task') {
        const { data } = msg
        this.emit(`task-${data.id}`, data.data)
      }
    })
  }

  async start() {
    switch (this.state) {
      case 'error':
      case 'terminating':
        throw new Error('Cannot start worker thread in current state')
      case 'starting':
      case 'pending': {
        const signal = AbortSignal.timeout(15000)
        try {
          await once(this, 'ready', { signal })
        } catch (err) {
          const error = new Error(
            'Worker thread did not become ready in time',
            { cause: err },
          )
          this.emit('error', error)
          this.stop()
          throw error
        }
      }
    }
  }

  async stop() {
    this.send({ type: 'stop' })
    const signal = AbortSignal.timeout(10000)
    try {
      await once(this.worker, 'exit', { signal })
    } catch (err) {
      console.dir(err)
      console.warn(
        `Worker thread ${this.worker.threadId} did not terminate in time, terminating forcefully...`,
      )
      this.worker.terminate()
    }
  }

  async run(task: WorkerJobTask) {
    const id = randomUUID()
    this.send({ type: 'task', data: { id, data: task } })
    return await once(this, `task-${id}`)
  }

  async send(msg: ThreadPortMessage) {
    this.port.postMessage(msg)
  }
}

export class Pool extends EventEmitter<{
  workerReady: [worker: Worker]
  workerTaskResult: [worker: Worker]
}> {
  protected readonly threadsPool: Thread[]
  protected runIndex = 0

  constructor(
    readonly options: {
      filename: string
      name: string
      threadsNumber: number
      workerData?: any
      extraWorkerData?: (index: number) => any
    },
  ) {
    super()
    this.threadsPool = Array.from({ length: options.threadsNumber })
  }

  async start() {
    const { threadsNumber } = this.options
    for (let i = 0; i < threadsNumber; i++) this.createThread(i)
    await Promise.all(this.threadsPool.map((thread) => thread.start()))
  }

  async stop() {
    await Promise.all(this.threadsPool.map((thread) => thread.stop()))
  }

  async run(task: WorkerJobTask) {
    if (this.runIndex >= this.threadsPool.length) {
      this.runIndex = 0
    }
    const thread = this.threadsPool[this.runIndex]
    this.runIndex++
    const [result] = await thread.run(task)
    return result
  }

  protected createThread(index: number) {
    const { port1, port2 } = new MessageChannel()
    const extraWorkerData = this.options.extraWorkerData
      ? this.options.extraWorkerData(index)
      : {}
    const thread = new Thread(port1, this.options.filename, {
      workerData: {
        ...this.options.workerData,
        ...extraWorkerData,
        port: port2,
      },
      name: `${this.options.name}-${index + 1}`,
      transferList: [port2],
    })
    this.threadsPool[index] = thread
    thread.once('error', () => {
      thread.worker.terminate()
      this.createThread(index)
    })
  }
}
