import type { ViteDevServer } from 'vite'

import type { ErrorPolicy } from './error-policy.ts'
import type { HMRCoordinator } from './hmr-coordinator.ts'
import { getErrorPolicy } from './error-policy.ts'

/**
 * Encapsulates everything that differs between Dev and Prod environments.
 * This provides a clean abstraction over environment-specific behavior.
 */
export interface RuntimeEnvironment {
  readonly mode: 'development' | 'production'
  readonly errorPolicy: ErrorPolicy
  readonly hmr: HMRCoordinator | null // null in prod
  readonly vite: ViteDevServer | null // null in prod
}

/**
 * Options for creating a development environment.
 */
export interface DevEnvironmentOptions {
  vite?: ViteDevServer
  hmr?: HMRCoordinator
}

/**
 * Creates a RuntimeEnvironment for the given mode.
 *
 * @param mode - 'development' or 'production'
 * @param options - Optional configuration (vite server for dev mode)
 */
export function createRuntimeEnvironment(
  mode: 'development' | 'production',
  options?: DevEnvironmentOptions,
): RuntimeEnvironment {
  const errorPolicy = getErrorPolicy(mode)

  if (mode === 'development') {
    return {
      mode,
      errorPolicy,
      hmr: options?.hmr ?? null,
      vite: options?.vite ?? null,
    }
  }

  // Production mode - no HMR or Vite
  return { mode, errorPolicy, hmr: null, vite: null }
}

/**
 * Type guard to check if environment is development mode.
 */
export function isDevEnvironment(
  env: RuntimeEnvironment,
): env is RuntimeEnvironment & {
  mode: 'development'
  hmr: HMRCoordinator | null
  vite: ViteDevServer | null
} {
  return env.mode === 'development'
}

/**
 * Type guard to check if environment is production mode.
 */
export function isProdEnvironment(
  env: RuntimeEnvironment,
): env is RuntimeEnvironment & { mode: 'production'; hmr: null; vite: null } {
  return env.mode === 'production'
}
