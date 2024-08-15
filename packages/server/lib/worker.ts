import {
  type MessagePort,
  isMainThread,
  parentPort,
  workerData,
} from 'node:worker_threads'
import {
  type Application,
  type BaseTaskExecutor,
  type Plugin,
  WorkerType,
} from '@nmtjs/application'
import {
  WorkerMessageType,
  bindPortMessageHandler,
  createBroadcastChannel,
  providerWorkerOptions,
} from './common.ts'
import { WTSubManagerPlugin } from './subscription.ts'
import { WorkerThreadsTaskRunner } from './task-runner.ts'

export type ApplicationWorkerOptions = {
  isServer: boolean
  workerType: WorkerType
  subscriptionManager: Plugin
  id: number
  workerOptions: any
  tasksRunner?: BaseTaskExecutor
}

export type ApplicationWorkerData = {
  applicationPath: string
  hasTaskRunners: boolean
} & Omit<ApplicationWorkerOptions, 'subscriptionManager' | 'taskRunner'>

if (!isMainThread) start(parentPort!, workerData)

export async function start(
  parentPort: MessagePort,
  workerData: ApplicationWorkerData,
) {
  bindPortMessageHandler(parentPort)

  const { id, workerOptions, applicationPath, workerType, hasTaskRunners } =
    workerData
  const isApiWorker = workerType === WorkerType.Api
  const isTaskWorker = workerType === WorkerType.Task
  const tasksRunner =
    isApiWorker && hasTaskRunners
      ? new WorkerThreadsTaskRunner(parentPort)
      : undefined

  providerWorkerOptions({
    id,
    workerType,
    workerOptions,
    tasksRunner,
    subscriptionManager: WTSubManagerPlugin,
    isServer: true,
  })

  const app: Application = await import(applicationPath).then((m) => m.default)

  process.on('uncaughtException', (err) => app.logger.error(err))
  process.on('unhandledRejection', (err) => app.logger.error(err))

  await app.startup()
  parentPort.postMessage({ type: WorkerMessageType.Ready })

  parentPort.on(WorkerMessageType.Stop, async () => {
    try {
      await app.shutdown()
      process.exit(0)
    } catch (err) {
      app.logger.error(err)
      process.exit(1)
    }
  })

  if (isTaskWorker) {
    parentPort.on(WorkerMessageType.ExecuteInvoke, async (payload) => {
      const { id, name, args } = payload
      const bc = createBroadcastChannel(id)

      try {
        const task = app.registry.tasks.get(name)
        if (!task) throw new Error('Task not found')
        const execution = app.execute(task, ...args)
        bc.once(WorkerMessageType.ExecuteAbort, (payload) => {
          const { reason } = payload
          execution.abort(reason)
        })
        bc.postMessage({
          type: WorkerMessageType.ExecuteResult,
          payload: await execution,
        })
      } catch (error) {
        bc.postMessage({
          type: WorkerMessageType.ExecuteResult,
          payload: { error },
        })
      } finally {
        bc.close()
      }
    })
  }

  return app
}
