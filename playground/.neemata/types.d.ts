/// <reference types="nmtjs/runtime/types" />

declare module 'nmtjs/runtime/types' {
  interface Applications {
    main: {
      type: 'neemata'
      definition: typeof import('../src/applications/main/index.ts').default
    }
  }
}
