import { createUnplugin } from 'unplugin'

import type { LabelsOptions } from './transform.ts'
import { transformLabels } from './transform.ts'

export type { LabelsOptions }
export {
  DEFAULT_FUNCTIONS,
  DEFAULT_MODULES,
  transformLabels,
} from './transform.ts'

const SOURCE_FILE_RE = /\.[cm]?[jt]sx?(?:\?|$)/

export const unpluginLabels = createUnplugin<LabelsOptions | undefined>(
  (options) => ({
    name: 'nmtjs:injectable-labels',
    // run before TS is stripped so declarations keep their original shape
    enforce: 'pre',
    transformInclude(id) {
      return SOURCE_FILE_RE.test(id) && !id.includes('node_modules')
    },
    transform(code, id) {
      return transformLabels(code, id, options) ?? null
    },
  }),
)

export default unpluginLabels
