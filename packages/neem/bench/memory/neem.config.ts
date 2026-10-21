import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  build: {
    ...(process.env.NEEM_BENCH_MAPS === 'off' ? { sourcemap: false } : {}),
    ...(process.env.NEEM_BENCH_MAPS === 'exclude'
      ? { sourcemapSources: 'exclude' as const }
      : process.env.NEEM_BENCH_MAPS === 'include'
        ? { sourcemapSources: 'include' as const }
        : {}),
  },
  plugins: [{ name: 'benchmark-ready', entry: './ready.ts' }],
  runtimes: ['./http.runtime.ts'],
})
