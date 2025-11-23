import { dirname, join } from 'node:path'

import type { Plugin } from 'vite'
import type { Target } from 'vite-plugin-static-copy'
import { viteStaticCopy } from 'vite-plugin-static-copy'

import { resolver } from '../resolver.ts'

const targets: Target[] = []

try {
  const { packageJsonPath } = resolver.sync(process.cwd(), '@nmtjs/proxy')
  if (packageJsonPath) {
    targets.push({
      src: join(dirname(packageJsonPath), 'neemata-proxy.node'),
      dest: './chunks/',
    })
  }
} catch {}

try {
  const { packageJsonPath } = resolver.sync(process.cwd(), 'uWebSockets.js')
  if (packageJsonPath) {
    targets.push({
      src: join(
        dirname(packageJsonPath),
        `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`,
      ),
      dest: './chunks/',
    })
  }
} catch {}

export const buildPlugins: Plugin[] = [
  ...(targets.length ? viteStaticCopy({ targets }) : []),
]
