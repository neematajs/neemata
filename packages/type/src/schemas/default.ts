import type { TSchema } from '@sinclair/typebox'

export type TDefault<Type extends TSchema, Default = unknown> = Type & {
  default: Default
}

export function Default<Type extends TSchema, const Default>(
  type: Type,
  default_: Default,
): TDefault<Type, Default> {
  return { ...type, default: default_ } as never
}
