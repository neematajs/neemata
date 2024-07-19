import { esbuildPluginFilePathExtensions } from 'esbuild-plugin-file-path-extensions'
import { defineConfig } from 'tsup'

export default defineConfig({
  outDir: 'dist',
  entry: ['cli.ts', 'bun.ts', 'node.ts'],
  sourcemap: true,
  bundle: true,
  clean: true,
  format: 'esm',
  target: 'node20',
  platform: 'node',
  esbuildPlugins: [
    esbuildPluginFilePathExtensions({
      esmExtension: 'js',
      cjsExtension: 'cjs',
      esm: ({ format }) => format === 'esm',
    }),
  ],
})
