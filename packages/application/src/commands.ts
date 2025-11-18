import type { Async } from '@nmtjs/common'
import type {
  Container,
  Dependant,
  Dependencies,
  DependencyContext,
} from '@nmtjs/core'
import type { AnyCompatibleType } from '@nmtjs/type'
import type { ArrayType } from '@nmtjs/type/array'
import type { ObjectType } from '@nmtjs/type/object'
import type { StringType } from '@nmtjs/type/string'
import { tryCaptureStackTrace } from '@nmtjs/common'
import { Scope } from '@nmtjs/core'
import { t } from '@nmtjs/type'

import type { LifecycleHooks } from '../../core/src/hooks/lifecycle-hooks.ts'
import type { ApplicationRegistry } from './registry.ts'
import { kCommand } from './constants.ts'
import { LifecycleHook } from './enums.ts'

export type CommandArgsType = AnyCompatibleType<(string | undefined)[]>
export type CommandKwargsType = AnyCompatibleType<
  Record<string, string | boolean | undefined>
>

type CommandHandlerType<
  Deps extends Dependencies,
  Args extends CommandArgsType,
  Kwargs extends CommandKwargsType,
  R,
> = (
  ctx: DependencyContext<Deps>,
  input: {
    args: t.infer.decode.output<Args>
    kwargs: t.infer.decode.output<Kwargs>
  },
  abortSignal: AbortSignal,
) => Async<R>

export interface Command<
  CommandName extends string = string,
  CommanDeps extends Dependencies = {},
  CommandArgs extends CommandArgsType = ArrayType<StringType>,
  CommandKwargs extends CommandKwargsType = ObjectType<{}>,
  CommandResult = unknown,
  CommandHandler extends CommandHandlerType<
    CommanDeps,
    CommandArgs,
    CommandKwargs,
    CommandResult
  > = CommandHandlerType<CommanDeps, CommandArgs, CommandKwargs, CommandResult>,
> extends Dependant<CommanDeps> {
  name: CommandName
  handler: CommandHandler
  args: CommandArgs
  kwargs: CommandKwargs
  [kCommand]: any
}

export type AnyCommand = Command<
  string,
  Dependencies,
  CommandArgsType,
  CommandKwargsType,
  any,
  any
>

export type CreateCommandOptions<
  CommandResult,
  CommandDeps extends Dependencies = {},
  CommandArgs extends CommandArgsType = ArrayType<StringType>,
  CommandKwargs extends CommandKwargsType = ObjectType<{}>,
> = {
  dependencies?: CommandDeps
  args?: CommandArgs
  kwargs?: CommandKwargs
  handler: CommandHandlerType<
    CommandDeps,
    CommandArgs,
    CommandKwargs,
    CommandResult
  >
}

export function createCommand<
  CommandName extends string,
  CommandDeps extends Dependencies,
  CommandResult,
  CommandArgs extends CommandArgsType = ArrayType<StringType>,
  CommandKwargs extends CommandKwargsType = ObjectType<{}>,
>(
  name: CommandName,
  params: CreateCommandOptions<
    CommandResult,
    CommandDeps,
    CommandArgs,
    CommandKwargs
  >,
): Command<
  CommandName,
  CommandDeps,
  CommandArgs,
  CommandKwargs,
  CommandResult
> {
  const dependencies = params.dependencies ?? ({} as CommandDeps)
  const { args, handler, kwargs } = params
  return Object.freeze({
    name,
    dependencies,
    handler,
    args: args ?? (t.array(t.string()) as unknown as CommandArgs),
    kwargs:
      kwargs ??
      (t.record(
        t.string(),
        t.or(t.string(), t.boolean()),
      ) as unknown as CommandKwargs),
    stack: tryCaptureStackTrace(),
    [kCommand]: true,
  })
}

export type CommandsOptions = { timeout: number }

export class Commands {
  constructor(
    private readonly application: {
      container: Container
      registry: ApplicationRegistry
      lifecycleHooks: LifecycleHooks
    },
    private readonly options: CommandsOptions,
  ) {}

  async execute<
    T extends AnyCommand,
    R extends T extends Command<any, any, any, any, infer Result>
      ? Result
      : unknown,
    A extends T extends Command<any, any, infer Args extends CommandArgsType>
      ? Args
      : never,
    K extends T extends Command<
      any,
      any,
      any,
      infer Kwargs extends CommandKwargsType
    >
      ? Kwargs
      : never,
  >(
    command: T,
    args: t.infer.decode.input<A> = [],
    kwargs: t.infer.decode.input<K> = {},
    abortSignal?: AbortSignal,
  ): Promise<R> {
    const { dependencies, handler } = command
    const container = this.application.container.fork(Scope.Global)
    const abortController = new AbortController()
    const signals = [
      abortController.signal,
      AbortSignal.timeout(this.options.timeout),
    ]
    if (abortSignal) signals.push(abortSignal)
    const handlerSignal = AbortSignal.any(signals)
    const context = await container.createContext(dependencies)
    const unregister = this.application.lifecycleHooks.hookOnce(
      LifecycleHook.DisposeBefore,
      () => abortController.abort(),
    )
    const commandArgs = command.args.decode(args)
    const commandKwargs = command.kwargs.decode(kwargs)
    const result = handler(
      context,
      { args: commandArgs, kwargs: commandKwargs },
      handlerSignal,
    )
    try {
      return await result
    } finally {
      unregister()
    }
  }

  async executeCommandByName(
    commandName: string,
    args: string[],
    kwargs: Record<string, string>,
    abortSignal?: AbortSignal,
  ) {
    const command = this.application.registry.commands.get(commandName)
    if (!command) throw new Error(`Command ${commandName} not found.`)
    return await this.execute(
      command,
      // @ts-expect-error
      args,
      kwargs,
      abortSignal,
    )
  }
}
