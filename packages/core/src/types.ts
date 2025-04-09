import type { Container } from './container.ts'
import type { Hooks } from './hooks.ts'
import type { Logger } from './logger.ts'
import type { Registry } from './registry.ts'

export interface PluginContext {
  logger: Logger
  registry: Registry
  hooks: Hooks
  container: Container
}

export type Pattern = RegExp | string | ((value: string) => boolean)
