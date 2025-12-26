import type { MessagePort, WorkerOptions } from 'node:worker_threads'
import { randomUUID } from 'node:crypto'
import EventEmitter, { once } from 'node:events'
import { MessageChannel, Worker } from 'node:worker_threads'

import type {
  JobTaskResult,
  ServerPortMessageTypes,
  ThreadErrorMessage,
  ThreadPortMessage,
  ThreadPortMessageTypes,
  WorkerJobTask,
  WorkerThreadError,
} from '../types.ts'

const omitExecArgv = ['--expose-gc']

export type ThreadState =
  | 'starting'
  | 'error'
  | 'terminating'
  | 'pending'
  | 'ready'

export class Thread extends EventEmitter<
  {
    error: [error: WorkerThreadError]
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
  protected readyMessage?: ThreadPortMessageTypes['ready']
  protected startPromise?: Promise<void>

  constructor(
    readonly port: MessagePort,
    workerPath: string,
    workerOptions: WorkerOptions,
  ) {
    super()
    this.worker = new Worker(workerPath, {
      ...workerOptions,
      execArgv: process.execArgv.filter((f) => !omitExecArgv.includes(f)),
    })

    this.port.on('message', (msg: ThreadPortMessage) => {
      const { type, data } = msg
      switch (type) {
        case 'ready': {
          this.state = 'ready'
          this.readyMessage = data
          this.emit('ready', data)
          break
        }
        case 'error': {
          const error = createWorkerThreadError(data as ThreadErrorMessage)
          this.state = 'error'
          this.emit('error', error)
          break
        }
        case 'task': {
          this.emit('task', data as ThreadPortMessageTypes['task'])
          const { id, task } = data as ThreadPortMessageTypes['task']
          this.emit(`task-${id}`, task)
          break
        }
      }
    })

    this.worker.once('exit', (code) => {
      if (this.state === 'terminating') return
      const error = createWorkerThreadError(
        {
          message: `Worker thread ${this.worker.threadId} exited unexpectedly with code ${code}`,
          name: 'WorkerThreadExitError',
          origin: 'runtime',
          fatal: code !== 0,
        },
        false,
      )
      this.state = 'error'
      this.emit('error', error)
    })
  }

  async start() {
    if (this.state === 'ready') return
    if (this.startPromise) return this.startPromise
    switch (this.state) {
      case 'error':
      case 'terminating':
      case 'starting':
        throw new Error('Cannot start worker thread in current state')
      case 'pending':
        break
    }
    this.state = 'starting'
    this.startPromise = new Promise<void>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout
      const cleanup = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        this.off('ready', handleReady)
        this.off('error', handleError)
        this.startPromise = undefined
      }
      const handleReady = () => {
        cleanup()
        resolve()
      }
      const handleError = (error: WorkerThreadError) => {
        cleanup()
        reject(error)
      }

      this.once('ready', handleReady)
      this.once('error', handleError)

      timer = setTimeout(() => {
        const error = createWorkerThreadError(
          {
            message: 'Worker thread did not become ready in time',
            name: 'WorkerStartupTimeoutError',
            origin: 'start',
            fatal: true,
          },
          false,
        )
        cleanup()
        this.state = 'error'
        this.emit('error', error)
        reject(error)
      }, 15000)
    })
    await this.startPromise
    this.startPromise = undefined
  }

  async stop() {
    switch (this.state) {
      case 'error':
      case 'terminating':
      case 'starting':
        throw new Error('Cannot stop worker thread in this state')
      case 'ready':
      case 'pending': {
        this.state = 'terminating'
        // TODO: make timeout configurable
        const signal = AbortSignal.timeout(10000)
        const exit = once(this.worker, 'exit', { signal })
        this.send('stop')
        this.port.close()
        try {
          await exit
        } catch (err) {
          console.dir(err)
          console.warn(
            `Worker thread ${this.worker.threadId} did not terminate in time, terminating forcefully...`,
          )
          await this.worker.terminate()
        }
      }
    }
  }

  async run(task: WorkerJobTask): Promise<JobTaskResult> {
    const id = randomUUID()
    this.send('task', { id, task })
    const [result] = await once(this, `task-${id}`)
    return result
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

function createWorkerThreadError(
  message: ThreadErrorMessage,
  includeStack = true,
): WorkerThreadError {
  const error = new Error(message.message) as WorkerThreadError
  if (message.name) error.name = message.name
  if (includeStack && message.stack) {
    error.stack = message.stack
  }
  error.origin = message.origin
  error.fatal = message.fatal
  return error
}

export class Pool extends EventEmitter<{
  workerReady: [worker: Worker]
  workerTaskResult: [worker: Worker]
}> {
  protected readonly threads: Thread[] = []

  constructor(
    readonly options: {
      path: string
      workerData?: any
      worker?: (worker: Worker) => any
    },
  ) {
    super()
  }

  add(options: { index: number; name: string; workerData?: any }) {
    return this.createThread(options)
  }

  async start() {
    await Promise.all(this.threads.map((thread) => thread.start()))
  }

  async stop() {
    await Promise.all(this.threads.map((thread) => thread.stop()))
  }

  protected createThread(
    options: { index: number; name: string; workerData?: any },
    index?: number,
  ) {
    const { port1, port2 } = new MessageChannel()
    const thread = new Thread(port1, this.options.path, {
      workerData: {
        ...this.options.workerData,
        ...options.workerData,
        port: port2,
      },
      name: `${options.name}-${options.index + 1}`,
      transferList: [port2],
    })
    if (index !== undefined) {
      this.threads[index] = thread
    } else {
      index = this.threads.push(thread) - 1
    }
    this.options.worker?.(thread.worker)
    thread.once('error', (error) => {
      thread.worker.terminate()
      this.createThread(options)
    })
    return thread
  }
}
