export type Pattern = RegExp | string | ((value: string) => boolean)

export type HookTypes = Record<string, (...args: any[]) => void>
