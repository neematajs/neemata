import type { Plugin as VitePlugin } from 'vite'

export type ExternalDependency = string | RegExp

type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Record<any, unknown> ? DeepPartial<T[P]> : T[P]
}

export interface NeemataConfig {
  /**
   * Path to application entry point
   */
  applications: {
    /**
     * Application name
     */
    [appName: string]: { type: 'neemata' | 'custom'; specifier: string }
  }
  /**
   * Path to server entry point
   */
  serverPath: string
  /**
   * External dependencies to exclude from application bundle
   *
   * 'prod' - exclude production dependencies from package.json
   *
   * 'all' - exclude all dependencies from package.json
   *
   * ExternalDependency[] - array of package names or regular expressions to match package names
   */
  externalDependencies: 'prod' | 'all' | ExternalDependency[]
  /**
   * Timeout in milliseconds for graceful shutdown of application workers
   */
  timeout: number

  /**
   * Environment variables to set for application workers
   *
   * Strings are paths to .env files
   * Records are key-value pairs to set directly
   */
  env: (Record<string, string> | string)[]

  build: { outDir: string; minify: boolean }
  plugins: VitePlugin[]
}

export function defineConfig(
  config: DeepPartial<NeemataConfig> = {},
): NeemataConfig {
  return {
    serverPath: './src/server.ts',
    externalDependencies: 'prod',
    timeout: 10000,
    env: [],
    plugins: [],
    ...config,
    // @ts-expect-error
    applications: config.applications || {},
    build: { outDir: './dist', minify: true, ...config.build },
  }
}
