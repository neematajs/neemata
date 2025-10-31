import type { core, ZodMiniType } from 'zod/mini'

export const PlainType: unique symbol = Symbol('PlainType')
export type PlainType = typeof PlainType

export type ZodPlainType<T extends ZodMiniType<any, any, any>> = T &
  ZodMiniType<
    T['_zod']['output'] & { [PlainType]?: true },
    T['_zod']['input'] & { [PlainType]?: true },
    core.$ZodTypeInternals<
      T['_zod']['output'] & { [PlainType]?: true },
      T['_zod']['input'] & { [PlainType]?: true }
    >
  >

export const zodPlainType = <T extends ZodMiniType<any, any, any>>(type: T) =>
  type as ZodPlainType<T>
