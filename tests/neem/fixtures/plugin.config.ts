import { defineConfig, definePlugin, defineRuntime } from '@nmtjs/neem'

function markerPlugin(marker: string) {
  return {
    name: `marker-${marker}`,
    transform(code: string, id: string) {
      if (!id.endsWith('runtime-app.ts')) return undefined
      return [
        code,
        'globalThis.__neemPluginMarkers ??= []',
        `globalThis.__neemPluginMarkers.push(${JSON.stringify(marker)})`,
      ].join('\n')
    },
  }
}

export default defineConfig({
  logger: './logger.ts',
  plugins: [
    definePlugin({
      name: 'hooks',
      entry: './plugin-hooks.ts',
      build: { rolldown: { plugins: [markerPlugin('a')] } },
      options: { label: 'first' },
    }),
    definePlugin({
      name: 'hooks',
      entry: './plugin-hooks.ts',
      build: { rolldown: { plugins: [markerPlugin('b')] } },
      options: { label: 'second' },
    }),
    definePlugin({
      name: 'build-only',
      build: { rolldown: { plugins: [markerPlugin('c')] } },
    }),
  ],
  runtimes: {
    api: defineRuntime({
      worker: { entry: './runtime-app.ts' },
      threads: [
        {
          label: 'one',
          http: { listen: { hostname: '127.0.0.1', port: 4101 } },
        },
      ],
    }),
  },
})
