import type { MessagePort, WorkerOptions } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import EventEmitter, { once } from 'node:events'
import { MessageChannel, Worker } from 'node:worker_threads'

import type {
  JobTaskResult,
  ServerPortMessageTypes,
  ThreadPortMessage,
  ThreadPortMessageTypes,
  WorkerJobTask,
} from '../types.ts'

export type ThreadState =
  | 'starting'
  | 'error'
  | 'terminating'
  | 'pending'
  | 'ready'

export class Thread extends EventEmitter<
  {
    error: [error: Error]
    ready: [ThreadPortMessageTypes['ready']]
    task: [ThreadPortMessageTypes['task']]
    terminate: []
  } & {
    [K in `task-${ThreadPortMessageTypes['task']['id']}`]: [
      ThreadPortMessageTypes['task']['task'],
    ]
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
    this.worker = new Worker(workerPath, {
      ...workerOptions,
      execArgv: ['--inspect=0'],
    })

    const handler = (msg: ThreadPortMessage) => {
      const { type, data } = msg
      this.emit(type, data as any)
      if (type === 'task') {
        const { id, task } = data as ThreadPortMessageTypes['task']
        this.emit(`task-${id}`, task)
      }
    }

    this.port.on('message', handler)
  }

  async start() {
    switch (this.state) {
      case 'error':
      case 'terminating':
      case 'starting':
        throw new Error('Cannot start worker thread in current state')
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
    switch (this.state) {
      case 'error':
      case 'terminating':
      case 'starting':
        throw new Error('Cannot stop worker thread in error state')
      case 'ready':
      case 'pending': {
        this.state = 'terminating'
        const signal = AbortSignal.timeout(10000)
        const exit = once(this.worker, 'exit', { signal }).finally(() => {
          console.log('here')
        })
        this.send('stop')
        try {
          await exit
        } catch (err) {
          console.dir(err)
          console.warn(
            `Worker thread ${this.worker.threadId} did not terminate in time, terminating forcefully...`,
          )
          this.worker.terminate()
        } finally {
          console.log('finally here')
        }
      }
    }
  }

  async run(task: WorkerJobTask) {
    const id = randomUUID()
    this.send('task', { id, task })
    return await once(this, `task-${id}`)
  }

  async send<T extends keyof ServerPortMessageTypes>(
    type: T,
    ...[data]: ServerPortMessageTypes[T] extends undefined
      ? []
      : [data: ServerPortMessageTypes[T]]
  ) {
    this.port.postMessage({ type, data })
  }
}

export class Pool extends EventEmitter<{
  workerReady: [worker: Worker]
  workerTaskResult: [worker: Worker]
}> {
  protected readonly threadsPool: Thread[] = []
  protected runIndex = 0

  constructor(readonly options: { filename: string; workerData?: any }) {
    super()
  }

  add(options: { index: number; name: string; workerData?: any }) {
    return this.createThread(options)
  }

  async start() {
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

  protected createThread(
    options: { index: number; name: string; workerData?: any },
    index?: number,
  ) {
    const { port1, port2 } = new MessageChannel()
    const thread = new Thread(port1, this.options.filename, {
      workerData: {
        ...this.options.workerData,
        ...options.workerData,
        port: port2,
      },
      name: `${options.name}-${options.index + 1}`,
      transferList: [port2],
    })
    if (index !== undefined) {
      this.threadsPool[index] = thread
    } else {
      index = this.threadsPool.push(thread) - 1
    }
    thread.once('error', (error) => {
      thread.worker.terminate()
      this.createThread(options)
    })
    return thread
  }
}
