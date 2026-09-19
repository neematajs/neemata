import type { core, ZodMiniString } from 'zod/mini'
import {
  base64,
  base64url,
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
  url,
  uuid,
  string as zodString,
} from 'zod/mini'

import { BaseType } from './base.ts'

type Check = core.CheckFn<string> | core.$ZodCheck<string>

export class StringType extends BaseType<
  ZodMiniString<string>,
  ZodMiniString<string>
> {
  static factory(...checks: Check[]) {
    return new StringType({
      encodeZodType: zodString().check(...checks),
      params: { checks },
    })
  }

  max(value: number) {
    return this.#check(maxLength(value))
  }

  min(value: number) {
    return this.#check(minLength(value))
  }

  pattern(pattern: string | RegExp) {
    return this.#check(
      regex(typeof pattern === 'string' ? new RegExp(pattern) : pattern),
    )
  }

  email(options?: core.$ZodEmailParams) {
    return this.#check(email(options))
  }

  url(options?: core.$ZodURLParams) {
    return this.#check(url(options))
  }

  ipv4(options?: core.$ZodIPv4Params) {
    return this.#check(ipv4(options))
  }

  ipv6(options?: core.$ZodIPv6Params) {
    return this.#check(ipv6(options))
  }

  uuid(options?: core.$ZodUUIDParams) {
    return this.#check(uuid(options))
  }

  emoji(options?: core.$ZodEmojiParams) {
    return this.#check(emoji(options))
  }

  nanoid(options?: core.$ZodNanoIDParams) {
    return this.#check(nanoid(options))
  }

  cuid(options?: core.$ZodCUIDParams) {
    return this.#check(cuid(options))
  }

  cuid2(options?: core.$ZodCUID2Params) {
    return this.#check(cuid2(options))
  }

  e164(options?: core.$ZodE164Params) {
    return this.#check(e164(options))
  }

  jwt(options?: core.$ZodJWTParams) {
    return this.#check(jwt(options))
  }

  base64(options?: core.$ZodBase64Params) {
    return this.#check(base64(options))
  }

  base64URL(options?: core.$ZodBase64URLParams) {
    return this.#check(base64url(options))
  }

  #check(check: Check) {
    return StringType.factory(...this.params.checks, check)
  }
}

export const string = StringType.factory
