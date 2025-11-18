import type { Plugin } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

export const VitePlugins: Plugin[] = [
  // @ts-expect-error
  viteStaticCopy({
    targets: [
      { src: '**/@nmtjs/proxy/neemata-proxy.node', dest: '.' },
      {
        src: `**/uWebSockets.js/uws_${process.platform}_${process.arch}_${process.versions.modules}.node`,
        dest: '.',
      },
    ],
  }),
]
