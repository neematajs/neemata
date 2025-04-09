import type { Pattern } from '../types.ts'

/**
 * Very simple pattern matching function.
 */
export function match(value: string, pattern: Pattern) {
  if (typeof pattern === 'function') {
    return pattern(value)
  } else if (typeof pattern === 'string') {
    if (pattern === '*' || pattern === '**') {
      return true
    } else if (pattern.at(0) === '*' && pattern.at(-1) === '*') {
      return value.includes(pattern.slice(1, -1))
    } else if (pattern.at(-1) === '*') {
      return value.startsWith(pattern.slice(0, -1))
    } else if (pattern.at(0) === '*') {
      return value.endsWith(pattern.slice(1))
    } else {
      return value === pattern
    }
  } else {
    return pattern.test(value)
  }
}

export function isJsFile(name: string) {
  if (name.endsWith('.d.ts')) return false
  const leading = name.split('.').slice(1)
  const ext = leading.join('.')
  return ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].includes(ext)
}
