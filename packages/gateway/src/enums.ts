export enum GatewayHook {
  Connect = 'Connect',
  Disconnect = 'Disconnect',
}

export enum ProxyableTransportType {
  WS = 'ws',
  HTTP = 'http',
  HTTP2 = 'http2',
}

export enum StreamTimeout {
  Pull = 'Pull',
  Consume = 'Consume',
  Finish = 'Finish',
}
