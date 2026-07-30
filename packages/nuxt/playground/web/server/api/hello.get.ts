export default defineEventHandler((event) => {
  return {
    message: 'hello from nitro',
    method: event.method,
  }
})
