export { match } from '@nmtjs/common'

export function isJsFile(name: string) {
  if (name.endsWith('.d.ts')) return false
  const leading = name.split('.').slice(1)
  const ext = leading.join('.')
  return ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts'].includes(ext)
}

export function pick<
  T extends object,
  K extends {
    [KK in keyof T as T[KK] extends (...args: any[]) => any ? never : KK]?: true
  },
>(
  obj: T,
  keys: K,
): Pick<
  T,
  keyof {
    [KK in keyof K as K[KK] extends true ? KK : never]: K[KK]
  }
> {
  const result = {} as any
  for (const key in keys) {
    if (key in obj) {
      result[key] = obj[key as unknown as keyof typeof obj]
    }
  }
  return result
}
