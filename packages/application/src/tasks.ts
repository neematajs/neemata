import type { Async } from '@nmtjs/common'
import type {
  Container,
  Dependant,
  Dependencies,
  DependencyContext,
} from '@nmtjs/core'
import { createPromise, defer, noopFn, onAbort } from '@nmtjs/common'
import { Hook, Scope } from '@nmtjs/core'

import type { ApplicationRegistry } from './registry.ts'
import { kTask } from './constants.ts'
import { AppInjectables } from './injectables.ts'

export type TaskExecution<Res = any> = PromiseLike<
  { result: Res; error?: never } | { result?: never; error: any }
> & { abort(reason?: any): void }

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
  [kTask]: any
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
  const parser = params.parser
  return { name, dependencies, handler, parser, [kTask]: true }
}

export type TasksOptions = { timeout: number; executor?: BaseTaskExecutor }

export class Tasks {
  constructor(
    private readonly application: {
      container: Container
      registry: ApplicationRegistry
    },
    private readonly options: TasksOptions,
  ) {}

  execute(task: AnyTask, ...args: any[]): TaskExecution {
    const ac = new AbortController()
    const result = createPromise()

    onAbort(ac.signal, result.reject)

    defer(async () => {
      const taskName = task.name

      ac.signal.throwIfAborted()

      if (this.options?.executor)
        return await this.options.executor.execute(ac.signal, taskName, ...args)

      const { dependencies, handler } = task
      const container = this.application.container.fork(Scope.Global)
      container.provide(AppInjectables.taskAbortSignal, ac.signal)
      const context = await container.createContext(dependencies)
      ac.signal.throwIfAborted()

      try {
        return await handler(context, ...args)
      } finally {
        container.dispose()
      }
    }).then(...result.toArgs())

    this.handleTermination(result.promise, ac)

    return Object.assign(
      result.promise
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
      await result.catch(noopFn)
    }
    const remove = this.application.registry.hooks.add(
      Hook.BeforeTerminate,
      abortExecution,
    )

    result.finally(remove).catch(noopFn)
  }
}
