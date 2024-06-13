import { esbuildPluginFilePathExtensions } from 'esbuild-plugin-file-path-extensions'
import { defineConfig } from 'tsup'

export default defineConfig({
  outDir: 'dist',
  entry: ['src/**/*.ts'],
  sourcemap: true,
  bundle: false,
  format: 'esm',
  target: 'esnext',
  platform: 'neutral',
  esbuildPlugins: [
    esbuildPluginFilePathExtensions({
      esmExtension: 'js',
      cjsExtension: 'cjs',
      esm: ({ format }) => format === 'esm',
    }),
  ],
})
