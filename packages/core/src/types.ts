export type Pattern = RegExp | string | ((value: string) => boolean)

export interface HookTypes extends Record<string, any[]> {}
