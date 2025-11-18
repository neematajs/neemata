declare module '#applications' {
  interface Applications {
    'test': typeof import('neemata-test-playground-app-1')
  }
}