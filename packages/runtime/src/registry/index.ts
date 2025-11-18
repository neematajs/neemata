import type {
  Dependant,
  Logger,
  Registry as RegistryInterface,
} from '@nmtjs/core'

export class Registry implements RegistryInterface {
  constructor(protected options: { logger: Logger }) {}

  *getDependants(): Generator<Dependant> {}
  clear(): void {}
}
