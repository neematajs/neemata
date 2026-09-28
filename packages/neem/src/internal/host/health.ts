import type {
  NeemRuntimeServerHealth,
  NeemServerConfig,
} from '../../shared/types.ts'

export type HealthPaths = { health: string; ready: string }

export type HealthStatus = { healthy: boolean; ready: boolean }

export function resolveHealthPaths(
  health: NeemServerConfig['health'],
): HealthPaths {
  return {
    health: normalizePath(health?.paths?.health, '/health'),
    ready: normalizePath(health?.paths?.ready, '/ready'),
  }
}

// A stopping server is unhealthy so platforms stop routing to it while it
// drains.
export function evaluateHealth(health: NeemRuntimeServerHealth): HealthStatus {
  return {
    healthy:
      health.state !== 'failed' &&
      health.state !== 'stopping' &&
      health.state !== 'stopped',
    ready: health.ready,
  }
}

function normalizePath(path: string | undefined, fallback: string): string {
  if (!path) return fallback
  return path.startsWith('/') ? path : `/${path}`
}
