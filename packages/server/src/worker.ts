import {
  isMainThread,
  type MessagePort,
  parentPort,
  workerData,
} from 'node:worker_threads'
import {
  Application,
  type ApplicationWorkerOptions,
  WorkerType,
} from '@nmtjs/application'
import {
  bindPortMessageHandler,
  createBroadcastChannel,
  WorkerMessageType,
} from './common.ts'
import { WorkerThreadsTaskRunner } from './task-runner.ts'

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

  const factory = await import(applicationPath).then((m) => m.default)
  if (typeof factory !== 'function')
    throw new Error('Invalid application factory')

  const app: Application = await factory({
    id,
    workerType,
    workerOptions,
    tasksRunner,
    isServer: true,
  })
  if (app instanceof Application === false)
    throw new Error('Invalid application factory')

  process.on('uncaughtException', (err) => app.logger.error(err))
  process.on('unhandledRejection', (err) => app.logger.error(err))

  await app.start()
  parentPort.postMessage({ type: WorkerMessageType.Ready })

  parentPort.on(WorkerMessageType.Stop, async () => {
    try {
      await app.stop()
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
