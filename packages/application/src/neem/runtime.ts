import { basename, dirname, join } from 'node:path'

import type { NeemRuntimeDeclaration, RolldownOptions } from '@nmtjs/neem'
import { createRuntime } from '@nmtjs/neem'

export type NeemataRuntimeConfig = NeemRuntimeDeclaration

export function createNeemataRuntime() {
  return createRuntime({
    worker: {
      build: { rolldown: { plugins: [createUwsNativeAddonPlugin()] } },
    },
  })
}

function createUwsNativeAddonPlugin(): NonNullable<RolldownOptions['plugins']> {
  return {
    name: 'neemata:uws-native-addon',
    async load(id) {
      if (!id.includes('uWebSockets.js/uws.js')) return null
      const nativeAddon = join(
        dirname(id),
        `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`,
      )
      const refId = this.emitFile({
        type: 'asset',
        name: basename(nativeAddon),
        source: await this.fs.readFile(nativeAddon),
      })

      return [
        'import { createRequire } from "node:module"',
        'const require = createRequire(import.meta.url)',
        `export default require(${JSON.stringify(`./${this.getFileName(refId)}`)})`,
      ].join('\n')
    },
  }
}
