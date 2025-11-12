import type { AnyInjectable, Depedency, Dependant, Logger } from '@nmtjs/core'
import { ApiRegistry } from '@nmtjs/api'
import {
  getDepedencencyInjectable,
  getInjectableScope,
  Scope,
} from '@nmtjs/core'

import type { AnyCommand } from './commands.ts'
import type { AnyJob } from './jobs.ts'

export class ApplicationRegistry extends ApiRegistry {
  readonly commands = new Map<string, AnyCommand>()
  readonly jobs = new Map<string, AnyJob>()

  constructor(protected readonly application: { logger: Logger }) {
    super(application)
  }

  registerCommand(command: AnyCommand) {
    if (this.commands.has(command.name))
      throw new Error(`Command ${command.name} already registered`)

    if (
      hasNonInvalidScopeDeps(
        Object.values<Depedency>(command.dependencies).map(
          getDepedencencyInjectable,
        ),
      )
    )
      throw new Error(scopeErrorMessage('Command dependencies'))

    this.application.logger.debug('Registering command [%s]', command.name)
    this.commands.set(command.name, command)
  }

  registerJob(job: AnyJob) {
    // might be re-registered when loading server scheduler jobs
    if (this.jobs.has(job.name))
      this.application.logger.debug(
        `Job ${job.name} is already registered, skipping registration`,
      )
    this.jobs.set(job.name, job)
  }

  *getDependants(): Generator<Dependant> {
    yield* super.getDependants()
    yield* this.commands.values()
    for (const job of this.jobs.values()) {
      yield* job.steps
    }
  }

  clear() {
    super.clear()
    this.commands.clear()
    this.jobs.clear()
  }
}

function scopeErrorMessage(name, scope = Scope.Global) {
  return `${name} must be a ${scope} scope (including all nested dependencies)`
}

function hasNonInvalidScopeDeps(
  injectables: AnyInjectable[],
  scope = Scope.Global,
) {
  return injectables.some((guard) => getInjectableScope(guard) !== scope)
}
