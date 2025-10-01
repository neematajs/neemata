import * as zod from 'zod/mini'

import { BaseType } from './base.ts'

type Check = zod.core.CheckFn<string> | zod.core.$ZodCheck<string>

export class StringType extends BaseType<
  zod.ZodMiniString<string>,
  zod.ZodMiniString<string>
> {
  static factory(...checks: Check[]) {
    return new StringType({
      encodedZodType: zod.string().check(...checks),
      params: { checks },
    })
  }

  max(value: number) {
    return StringType.factory(...this.params.checks, zod.maxLength(value))
  }

  min(value: number) {
    return StringType.factory(...this.params.checks, zod.minLength(value))
  }

  pattern(pattern: string | RegExp) {
    return StringType.factory(
      ...this.params.checks,
      zod.regex(typeof pattern === 'string' ? new RegExp(pattern) : pattern),
    )
  }

  email(options?: zod.core.$ZodEmailParams) {
    return StringType.factory(...this.params.checks, zod.email(options))
  }

  url(options?: zod.core.$ZodURLParams) {
    return StringType.factory(...this.params.checks, zod.url(options))
  }

  ipv4(options?: zod.core.$ZodIPv4Params) {
    return StringType.factory(...this.params.checks, zod.ipv4(options))
  }

  ipv6(options?: zod.core.$ZodIPv6Params) {
    return StringType.factory(...this.params.checks, zod.ipv6(options))
  }

  uuid(options?: zod.core.$ZodUUIDParams) {
    return StringType.factory(...this.params.checks, zod.uuid(options))
  }

  emoji(options?: zod.core.$ZodEmojiParams) {
    return StringType.factory(...this.params.checks, zod.emoji(options))
  }

  nanoid(options?: zod.core.$ZodNanoIDParams) {
    return StringType.factory(...this.params.checks, zod.nanoid(options))
  }

  cuid(options?: zod.core.$ZodCUIDParams) {
    return StringType.factory(...this.params.checks, zod.cuid(options))
  }

  cuid2(options?: zod.core.$ZodCUID2Params) {
    return StringType.factory(...this.params.checks, zod.cuid2(options))
  }

  e164(options?: zod.core.$ZodE164Params) {
    return StringType.factory(...this.params.checks, zod.e164(options))
  }

  jwt(options?: zod.core.$ZodJWTParams) {
    return StringType.factory(...this.params.checks, zod.jwt(options))
  }
}

export const string = StringType.factory
