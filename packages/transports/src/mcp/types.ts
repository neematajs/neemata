import type {
  OAuthProtectedResourceMetadata,
  OAuthTokenVerifier,
} from '@modelcontextprotocol/server'

export interface McpServerInfo {
  name: string
  version: string
  title?: string
}

export interface McpToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface McpToolConfig {
  /** Native procedure name (e.g. `users/create`). */
  procedure: string
  /**
   * Public tool name. Defaults to the native name with `/` replaced
   * by `_` (e.g. `users_create`).
   */
  name?: string
  title?: string
  /**
   * Tool description shown to agents. Defaults to the procedure contract's
   * description; required when the contract has none.
   */
  description?: string
  annotations?: McpToolAnnotations
}

export interface McpAuthOptions {
  /**
   * Access-token verifier (RFC 9068 JWT via the authorization server's
   * JWKS, introspection, etc.). With better-auth 1.7+, implement this over
   * `@better-auth/mcp`'s verification helpers.
   */
  verifier: OAuthTokenVerifier
  /** Scopes the token must carry; missing scopes answer 403 insufficient_scope. */
  requiredScopes?: string[]
  /**
   * RFC 9728 Protected Resource Metadata URL advertised in WWW-Authenticate
   * challenges so clients can discover the authorization server.
   */
  resourceMetadataUrl?: string
  /**
   * When set, the handler also serves this document at
   * `/.well-known/oauth-protected-resource` on the shared host.
   */
  protectedResourceMetadata?: OAuthProtectedResourceMetadata
}

export interface McpHandlerOptions {
  path: `/${string}`
  serverInfo: McpServerInfo
  /** Optional usage instructions surfaced to clients. */
  instructions?: string
  tools: McpToolConfig[]
  /** Bearer-token authorization for the MCP endpoint. */
  auth?: McpAuthOptions
}
