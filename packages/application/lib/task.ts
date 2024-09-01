import type { ApplicationOptions } from './application.ts'
import { injectables } from './common.ts'
import { Hook, TaskKey } from './constants.ts'
import type {
  Container,
  Dependant,
  Dependencies,
  DependencyContext,
} from './container.ts'
import type { Registry } from './registry.ts'
import type { Async, OmitFirstItem } from './types.ts'
import { createFuture, defer, merge, noop, onAbort } from './utils/functions.ts'

export type TaskExecution<Res = any> = PromiseLike<
  { result: Res; error?: never } | { result?: never; error: any }
> & {
  abort(reason?: any): void
}

export type TasksRunner = (
  signal: AbortSignal,
  name: string,
  ...args: any[]
) => Promise<any>

type TaskHandlerType<Deps extends Dependencies, A extends any[], R> = (
  ctx: DependencyContext<Deps>,
  ...args: A
) => Async<R>

type TaskParserType<TaskArgs extends any[]> = (
  args: string[],
  kwargs: Record<string, any>,
) => Async<TaskArgs | Readonly<TaskArgs>>

export interface BaseTaskExecutor {
  execute(signal: AbortSignal, name: string, ...args: any[]): Promise<any>
}

export interface Task<
  TaskName extends string = string,
  TaskDeps extends Dependencies = {},
  TaskArgs extends any[] = [],
  TaskResult = unknown,
  TaskHandler extends TaskHandlerType<
    TaskDeps,
    TaskArgs,
    TaskResult
  > = TaskHandlerType<TaskDeps, TaskArgs, TaskResult>,
> extends Dependant<TaskDeps> {
  name: TaskName
  handler: TaskHandler
  parser?: TaskParserType<TaskArgs>
  [TaskKey]: any
}

export type AnyTask = Task<string, Dependencies, any[], any, any>

export type CreateTaskOptions<
  TaskDeps extends Dependencies,
  TaskArgs extends any[],
  TaskResult,
> =
  | {
      dependencies?: TaskDeps
      handler: TaskHandlerType<TaskDeps, TaskArgs, TaskResult>
      parser?: TaskParserType<TaskArgs>
    }
  | TaskHandlerType<TaskDeps, TaskArgs, TaskResult>

export function createTask<
  TaskName extends string,
  TaskDeps extends Dependencies,
  TaskArgs extends any[],
  TaskResult,
>(
  name: TaskName,
  paramsOrHandler: CreateTaskOptions<TaskDeps, TaskArgs, TaskResult>,
): Task<TaskName, TaskDeps, TaskArgs, TaskResult> {
  const params =
    typeof paramsOrHandler === 'function'
      ? { handler: paramsOrHandler }
      : paramsOrHandler
  const dependencies = params.dependencies ?? ({} as TaskDeps)
  const handler = params.handler
  const parser = params.parser ?? notImplemented(name, 'parser')
  return { name, dependencies, handler, parser, [TaskKey]: true }
}

export class TaskRunner {
  constructor(
    private readonly application: { container: Container; registry: Registry },
    private readonly options: ApplicationOptions['tasks'],
  ) {}

  execute(task: AnyTask, ...args: any[]): TaskExecution {
    const ac = new AbortController()
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
      container.provide(injectables.taskSignal, ac.signal)
      const context = await container.createContext(dependencies)
      try {
        return await handler(context, ...args)
      } finally {
        container.dispose()
      }
    }).then(...future.asArgs)

    this.handleTermination(future.promise, ac)

    return Object.assign(
      future.promise
        .then((result) => ({ result }))
        .catch((error = new Error('Task execution error')) => ({ error })),
      { abort: ac.abort.bind(ac) },
    ) satisfies TaskExecution as TaskExecution
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
    abortController: AbortController,
  ) {
    const abortExecution = async () => {
      abortController.abort()
      await result.catch(noop)
    }
    const remove = this.application.registry.hooks.add(
      Hook.BeforeTerminate,
      abortExecution,
    )

    result.finally(remove).catch(noop)
  }
}

const notImplemented = (taskName: string, fnType: string) => () => {
  throw new Error(`Task [${taskName}] ${fnType} is not implemented`)
}
