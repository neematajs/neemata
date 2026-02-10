import { vi } from 'vitest'

const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const compilePattern = (pattern: string) => {
  const parts = pattern.split('*').map((part) => escapeRegex(part))
  return new RegExp(`^${parts.join('.*')}$`)
}

const matchesPattern = (value: string, pattern: any) => {
  if (typeof pattern === 'string') {
    if (pattern.includes('*')) return compilePattern(pattern).test(value)
    return value === pattern
  }
  if (pattern instanceof RegExp) return pattern.test(value)
  if (typeof pattern === 'function') return !!pattern(value)
  return false
}

const createLogger = () => {
  const logger = {
    child: () => logger,
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  }
  return logger
}

vi.mock('@nmtjs/core', () => ({
  match: matchesPattern,
  createLogger,
  Scope: { Connection: Symbol('connection'), Call: Symbol('call') },
  provide: vi.fn(),
}))
