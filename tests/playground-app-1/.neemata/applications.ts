declare module 'nmtjs/runtime' {
  export interface Applications {
    test: typeof import('../src/application.js')
  }
}
