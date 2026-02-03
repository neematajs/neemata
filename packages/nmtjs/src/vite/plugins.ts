import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { Plugin } from 'vite'

export const plugins: Plugin[] = [
  {
    name: 'neemata:native-addon',
    apply: 'build',
    enforce: 'pre',

    async load(id) {
      if (id.endsWith('.node') && existsSync(id)) {
        const refId = this.emitFile({
          type: 'asset',
          name: basename(id),
          source: await readFile(id),
        })
        const runtimePath = `./${this.getFileName(refId)}`
        return `export default require(${JSON.stringify(runtimePath)});`
      }
      return null
    },
  },
  {
    name: 'neemata:uws-native-addon',
    apply: 'build',
    enforce: 'post',
    async load(id) {
      if (id.includes('uWebSockets.js/uws.js')) {
        const uwsNodeAddonPath = join(
          dirname(id),
          `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`,
        )
        const refId = this.emitFile({
          type: 'asset',
          name: basename(uwsNodeAddonPath),
          source: await readFile(uwsNodeAddonPath),
        })
        const runtimePath = `./${this.getFileName(refId)}`
        return `export default require(${JSON.stringify(runtimePath)});`
      }
      return null
    },
  },
]
