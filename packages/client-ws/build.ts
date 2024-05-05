import { dependencies } from './package.json'

const entrypoints = ['index.ts']
Bun.build({
  entrypoints,
  minify: true,
  target: 'browser',
  outdir: 'dist',
  sourcemap: 'external',
  external: Object.keys(dependencies),
})
