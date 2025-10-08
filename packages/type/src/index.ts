import { en } from 'zod/locales'
import { config } from 'zod/mini'

import * as type from './types/_type.ts'

config(en())

export * from './types/base.ts'
export { type, type as t }
export default type
