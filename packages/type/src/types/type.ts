import type { BaseTypeAny } from './base.ts'

export * from './any.ts'
export * from './array.ts'
export * from './boolean.ts'
export * from './custom.ts'
export * from './date.ts'
export * from './enum.ts'
export * from './literal.ts'
export * from './never.ts'
export * from './number.ts'
export * from './object.ts'
export * from './string.ts'
export * from './tuple.ts'
export * from './union.ts'

export namespace infer {
  export namespace decoded {
    export type input<T extends BaseTypeAny> =
      T['decodedZodType']['_zod']['input']
    export type output<T extends BaseTypeAny> =
      T['decodedZodType']['_zod']['output']
  }

  export namespace encoded {
    export type input<T extends BaseTypeAny> =
      T['encodedZodType']['_zod']['input']
    export type output<T extends BaseTypeAny> =
      T['encodedZodType']['_zod']['output']
  }
}
