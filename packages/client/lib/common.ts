export class ClientError extends Error {
  constructor(
    public code: string,
    message?: string,
    public data?: any,
  ) {
    super(message)
  }
}
