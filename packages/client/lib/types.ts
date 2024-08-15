import type { ApiBlob, ApiBlobInterface } from '@nmtjs/common'
import type { ClientDownStreamBlob } from './stream.ts'

export type ClientCallOptions = {
  signal?: AbortSignal
}

export type InputType<T> = T extends any[]
  ? InputType<T[number]>[]
  : T extends ApiBlobInterface
    ? ApiBlob
    : T extends object
      ? { [K in keyof T]: InputType<T[K]> }
      : T

export type OutputType<T> = T extends any[]
  ? OutputType<T[number]>[]
  : T extends ApiBlobInterface
    ? ClientDownStreamBlob
    : T extends object
      ? { [K in keyof T]: OutputType<T[K]> }
      : T
