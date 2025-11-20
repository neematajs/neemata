import { join } from 'node:path'

import type { Plugin } from 'vite'
import type { Target } from 'vite-plugin-static-copy'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const targets: Target[] = []

try {
  const neemataProxyPath = import.meta.resolve('@nmtjs/proxy')
  targets.push({ src: join(neemataProxyPath, 'neemata-proxy.node'), dest: '.' })
} catch {}

try {
  const uwsPath = import.meta.resolve('uWebSockets.js')
  targets.push({
    src: join(
      uwsPath,
      `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`,
    ),
    dest: '.',
  })
} catch {}

export const buildPlugins: Plugin[] = [
  ...(targets.length ? viteStaticCopy({ targets }) : []),
]
