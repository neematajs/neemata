import {
  type core,
  cuid,
  cuid2,
  e164,
  email,
  emoji,
  ipv4,
  ipv6,
  jwt,
  maxLength,
  minLength,
  nanoid,
  regex,
  string,
  url,
  uuid,
  type ZodMiniString,
} from '@zod/mini'

import { BaseType } from './base.ts'

type Check = core.CheckFn<string> | core.$ZodCheck<string>

export class StringType extends BaseType<
  ZodMiniString<string>,
  ZodMiniString<string>
> {
  static factory(...checks: Check[]) {
    return new StringType({
      encodedZodType: string().check(...checks),
      params: { checks },
    })
  }

  max(value: number) {
    return StringType.factory(...this.params.checks, maxLength(value))
  }

  min(value: number) {
    return StringType.factory(...this.params.checks, minLength(value))
  }

  pattern(pattern: string | RegExp) {
    return StringType.factory(
      ...this.params.checks,
      regex(typeof pattern === 'string' ? new RegExp(pattern) : pattern),
    )
  }

  email(options?: core.$ZodEmailParams) {
    return StringType.factory(...this.params.checks, email(options))
  }

  url(options?: core.$ZodURLParams) {
    return StringType.factory(...this.params.checks, url(options))
  }

  ipv4(options?: core.$ZodIPv4Params) {
    return StringType.factory(...this.params.checks, ipv4(options))
  }

  ipv6(options?: core.$ZodIPv6Params) {
    return StringType.factory(...this.params.checks, ipv6(options))
  }

  uuid(options?: core.$ZodUUIDParams) {
    return StringType.factory(...this.params.checks, uuid(options))
  }

  emoji(options?: core.$ZodEmojiParams) {
    return StringType.factory(...this.params.checks, emoji(options))
  }

  nanoid(options?: core.$ZodNanoIDParams) {
    return StringType.factory(...this.params.checks, nanoid(options))
  }

  cuid(options?: core.$ZodCUIDParams) {
    return StringType.factory(...this.params.checks, cuid(options))
  }

  cuid2(options?: core.$ZodCUID2Params) {
    return StringType.factory(...this.params.checks, cuid2(options))
  }

  e164(options?: core.$ZodE164Params) {
    return StringType.factory(...this.params.checks, e164(options))
  }

  jwt(options?: core.$ZodJWTParams) {
    return StringType.factory(...this.params.checks, jwt(options))
  }
}
