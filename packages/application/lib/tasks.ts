import type { ApplicationOptions } from './application.ts'
import { Hook } from './constants.ts'
import {
  type Container,
  type Dependencies,
  type DependencyContext,
  type Depender,
  Provider,
} from './container.ts'
import type { Registry } from './registry.ts'
import type { AnyTask, OmitFirstItem } from './types.ts'
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

export abstract class BaseTaskRunner {
  abstract execute(
    signal: AbortSignal,
    name: string,
    ...args: any[]
  ): Promise<any>
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

  static signal = new Provider<AbortSignal>().withDescription(
    'Task abort signal',
  )

  readonly name!: string
  readonly dependencies: TaskDeps = {} as TaskDeps
  readonly handler!: this['_']['handler']
  readonly parser!: (
    args: string[],
    kwargs: Record<string, any>,
  ) => TaskArgs | Readonly<TaskArgs>

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

export class Tasks {
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

      if (this.options?.runner)
        return await this.options.runner.execute(ac.signal, taskName, ...args)

      const { dependencies, handler } = task
      const container = this.application.container.createScope(
        this.application.container.scope,
      )
      container.provide(Task.signal, ac.signal)
      const context = await container.createContext(dependencies)
      return await handler(context, ...args)
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
        'Task not found. You might forgot to register with `app.withTasks(task)`',
      )
    const { parser } = task
    const parsedArgs = parser ? parser(taskArgs, kwargs) : []
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
    const unregisterHook = this.application.registry.hooks.add(
      Hook.BeforeTerminate,
      abortExecution,
    )
    result.finally(unregisterHook).catch(noop)
  }
}
