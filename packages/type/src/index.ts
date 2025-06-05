import * as zod from 'zod/v4-mini'
import * as type from './types/type.ts'

zod.config(zod.core.locales.en())

export * from './types/base.ts'
export { type, type as t }
export default type
