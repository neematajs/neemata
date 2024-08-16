import type { ApplicationOptions } from './application.ts'
import { Hook } from './constants.ts'
import type {
  Container,
  Dependencies,
  DependencyContext,
  Depender,
} from './container.ts'
import { providers } from './providers.ts'
import type { Registry } from './registry.ts'
import type { AnyTask, Async, OmitFirstItem } from './types.ts'
import { createFuture, defer, merge, noop, onAbort } from './utils/functions.ts'

export type TaskExecution<Res = any> = Promise<
  { result: Res; error: never } | { result: never; error: any }
> & {
  abort(reason?: any): void
}

export type TasksRunner = (
  signal: AbortSignal,
  name: string,
  ...args: any[]
) => Promise<any>

type Handler<Deps extends Dependencies> = (
  ctx: DependencyContext<Deps>,
  ...args: any[]
) => any

export interface BaseTaskExecutor {
  execute(signal: AbortSignal, name: string, ...args: any[]): Promise<any>
}

export class Task<
  TaskDeps extends Dependencies = {},
  TaskHandler extends Handler<TaskDeps> = Handler<TaskDeps>,
  TaskType = unknown,
  TaskArgs extends any[] = [],
> implements Depender<TaskDeps>
{
  _!: {
    type: TaskType
    handler: Handler<TaskDeps>
    args: TaskArgs
  }

  readonly name!: string
  readonly dependencies: TaskDeps = {} as TaskDeps
  readonly handler!: this['_']['handler']
  readonly parser!: (
    args: string[],
    kwargs: Record<string, any>,
  ) => Async<TaskArgs | Readonly<TaskArgs>>

  withName(name: string) {
    const task = new Task<TaskDeps, TaskHandler, TaskType, TaskArgs>()
    Object.assign(task, this, { name })
    return task
  }

  withDependencies<NewDeps extends Dependencies>(dependencies: NewDeps) {
    const task = new Task<
      TaskDeps & NewDeps,
      Handler<TaskDeps & NewDeps>,
      TaskType,
      TaskArgs
    >()
    Object.assign(task, this, {
      dependencies: merge(this.dependencies, dependencies),
    })
    return task
  }

  withHandler<NewHandler extends Handler<TaskDeps>>(handler: NewHandler) {
    const task = new Task<
      TaskDeps,
      TaskHandler,
      Awaited<ReturnType<NewHandler>>,
      OmitFirstItem<Parameters<NewHandler>>
    >()
    Object.assign(task, this, { handler })
    return task
  }

  withParser(parser: this['parser']) {
    const task = new Task<TaskDeps, TaskHandler, TaskType, TaskArgs>()
    Object.assign(task, this, { parser })
    return task
  }
}

export class TaskRunner {
  constructor(
    private readonly application: { container: Container; registry: Registry },
    private readonly options: ApplicationOptions['tasks'],
  ) {}

  execute(task: AnyTask, ...args: any[]): TaskExecution {
    const ac = new AbortController()
    const abort = (reason?: any) => ac.abort(reason ?? new Error('Aborted'))
    const future = createFuture()

    onAbort(ac.signal, future.reject)

    defer(async () => {
      const taskName = task.name

      ac.signal.throwIfAborted()

      if (this.options?.executor)
        return await this.options.executor.execute(ac.signal, taskName, ...args)

      const { dependencies, handler } = task
      const container = this.application.container.createScope(
        this.application.container.scope,
      )
      container.provide(providers.taskSignal, ac.signal)
      const context = await container.createContext(dependencies)
      try {
        return await handler(context, ...args)
      } finally {
        container.dispose()
      }
    }).then(...future.toArgs())

    this.handleTermination(future.promise, abort)

    return Object.assign(
      future.promise
        .then((result) => ({ result }))
        .catch((error = new Error('Task execution')) => ({ error })),
      { abort },
    ) as TaskExecution
  }

  async command({ args, kwargs }) {
    const [name, ...taskArgs] = args
    const task = this.application.registry.tasks.get(name)
    if (!task)
      throw new Error(
        'Task not found. You might forgot to register it with `app.withTasks(yourTask)`',
      )
    const { parser } = task
    const parsedArgs = parser ? await parser(taskArgs, kwargs) : []
    return await this.execute(task, ...parsedArgs)
  }

  private handleTermination(
    result: Promise<any>,
    abort: (reason?: any) => void,
  ) {
    const abortExecution = async () => {
      abort()
      await result.catch(noop)
    }
    const remove = this.application.registry.hooks.add(
      Hook.BeforeTerminate,
      abortExecution,
    )

    result.finally(remove).catch(noop)
  }
}
