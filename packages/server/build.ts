const path = Bun.fileURLToPath(new URL('./', import.meta.url) as any)
const glob = new Bun.Glob('lib/**/*.ts').scan(path)
const entrypoints = ['index.ts']
for await (const e of glob) entrypoints.push(e)
Bun.build({
  entrypoints,
  external: ['*'],
  minify: true,
  target: 'bun',
  sourcemap: 'external',
  outdir: 'dist',
})
