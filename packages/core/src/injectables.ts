import { createLazyInjectable } from './container.ts'
import { Scope } from './enums.ts'
import type { Logger } from './logger.ts'

const logger = createLazyInjectable<Logger>(Scope.Global, 'Logger')

export const CoreInjectables = { logger }
