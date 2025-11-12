import { en } from 'zod/locales'
import { config } from 'zod/mini'

import * as type from './types/_type.ts'

config(en())

export * from './types/_convert.ts'
export * from './types/_utils.ts'
export * from './types/base.ts'
export { type, type as t }
export default type
