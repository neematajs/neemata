import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { Plugin } from 'vite'

import type { NeemPoolHmrUpdate, NeemPoolId } from '../types.ts'
import { neemRuntimeModuleId } from '../runtime-module.ts'

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
        return (
          `const id = ${JSON.stringify(runtimePath)};` +
          `export default require(id);`
        )
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
        return (
          `const id = ${JSON.stringify(runtimePath)};` +
          `export default require(id);`
        )
      }
      return null
    },
  },
]

export function createPoolHmrPlugin(options: {
  poolId: NeemPoolId
  environmentName: string
  entrypoints: string[]
  onUpdate?: (update: NeemPoolHmrUpdate) => void
}): Plugin {
  const hotAcceptEntrypoints = new Set(
    options.entrypoints.map(normalizeModuleId),
  )
  const injectHmr = `\n\nif(import.meta.hot) { import.meta.hot.accept((module) => globalThis._hotAccept?.(module)) }`

  return {
    name: `neem:pool-hmr:${options.poolId}`,
    transform(code, id) {
      if (!hotAcceptEntrypoints.has(normalizeModuleId(id))) return
      return code + injectHmr
    },
    handleHotUpdate(ctx) {
      options.onUpdate?.({
        poolId: options.poolId,
        environmentName: options.environmentName,
        file: ctx.file,
      })
    },
  }
}

export function createRuntimeModulePlugin(source: string): Plugin {
  const resolvedId = '\0neem:runtime'

  return {
    name: 'neem:runtime-module',
    resolveId(id) {
      if (id === neemRuntimeModuleId) {
        return resolvedId
      }

      return null
    },
    load(id) {
      if (id === resolvedId) {
        return source
      }

      return null
    },
  }
}

function normalizeModuleId(id: string): string {
  const [withoutQuery] = id.split('?', 1)
  const [withoutHash] = withoutQuery.split('#', 1)

  return withoutHash.startsWith('file://')
    ? new URL(withoutHash).pathname
    : withoutHash
}
