/// <reference types="@nmtjs/runtime/types" />

declare module '@nmtjs/runtime/types' {
  interface Applications {
    'test': typeof import('neemata-test-playground-app-1').default
  }
}