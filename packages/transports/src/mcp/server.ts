import type {
  AuthInfo,
  CallToolResult,
  McpHttpHandler,
  McpRequestContext,
} from '@modelcontextprotocol/server'
import type {
  GatewayConnection,
  GatewayResolvedProcedure,
  TransportWorkerParams,
} from '@nmtjs/gateway'
import type { BaseTypeAny } from '@nmtjs/type'
import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  requireBearerAuth,
} from '@modelcontextprotocol/server'
import { createLazyInjectable, provision, Scope } from '@nmtjs/core'
import { ProxyableTransportType } from '@nmtjs/gateway'
import { ConnectionType, ProtocolVersion } from '@nmtjs/protocol'
import { ProtocolError } from '@nmtjs/protocol/server'

import type { ServerHandler } from '../transport.ts'
import type { ToolInputSchema } from './schema.ts'
import type { McpHandlerOptions, McpToolConfig } from './types.ts'
import { emitToolInputSchema } from './schema.ts'

const JSON_CONTENT_TYPE = 'application/json'
const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource'
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/

/**
 * Verified OAuth token information for the current MCP request, provisioned
 * per connection when the handler is configured with `auth`.
 */
export const mcpAuthInfo = createLazyInjectable<AuthInfo, Scope.Connection>(
  Scope.Connection,
  'MCP auth info',
)

/** Operator-facing tool configuration problem — message is safe to surface. */
class McpConfigError extends Error {}

export interface McpResolvedProcedure extends GatewayResolvedProcedure {
  readonly procedure: Readonly<{
    contract: { input: BaseTypeAny; description?: string; title?: string }
  }>
}

const injectables = { mcpAuthInfo }

export function mcp(): ServerHandler<
  ConnectionType.Unidirectional,
  McpHandlerOptions,
  typeof injectables,
  readonly [ProxyableTransportType.HTTP],
  McpResolvedProcedure
> {
  return {
    proxyable: [ProxyableTransportType.HTTP],
    injectables,
    mount({ host, gateway }, options) {
      const handler = new McpHandler(gateway, options)
      const unmounts = [
        host.mountFetchHandler({
          path: options.path,
          handler: handler.handle.bind(handler),
        }),
      ]
      const metadata = options.auth?.protectedResourceMetadata
      if (metadata) {
        unmounts.push(
          host.mountFetchHandler({
            path: PROTECTED_RESOURCE_PATH,
            handler: async () =>
              new Response(JSON.stringify(metadata), {
                status: 200,
                headers: { 'Content-Type': JSON_CONTENT_TYPE },
              }),
          }),
        )
      }
      return {
        dispose: () => {
          for (const unmount of unmounts) unmount()
        },
      }
    },
  }
}

type RequestState = {
  connection: GatewayConnection & AsyncDisposable
  nextCallId: number
}

export class McpHandler {
  #tools = new Map<string, McpToolConfig>()
  #gate?: (request: Request) => Promise<AuthInfo | Response>
  #mcp: McpHttpHandler
  // keyed by the Request identity the SDK hands back via ctx.requestInfo
  #states = new WeakMap<Request, RequestState>()

  constructor(
    readonly params: TransportWorkerParams<
      ConnectionType.Unidirectional,
      McpResolvedProcedure
    >,
    readonly options: McpHandlerOptions,
  ) {
    for (const tool of options.tools) {
      const name = tool.name ?? tool.procedure.replaceAll('/', '_')
      if (!TOOL_NAME_PATTERN.test(name)) {
        throw new Error(`Invalid MCP tool name "${name}"`)
      }
      if (this.#tools.has(name)) {
        throw new Error(`Duplicate MCP tool name "${name}"`)
      }
      this.#tools.set(name, tool)
    }

    if (options.auth) {
      this.#gate = requireBearerAuth({
        verifier: options.auth.verifier,
        requiredScopes: options.auth.requiredScopes,
        resourceMetadataUrl: options.auth.resourceMetadataUrl,
      })
    }

    // 2026-07-28 only: 2025-era (session/handshake) traffic is rejected by
    // the SDK's era classification
    this.#mcp = createMcpHandler((ctx) => this.createServer(ctx), {
      legacy: 'reject',
    })
  }

  async handle(request: Request): Promise<Response> {
    let authInfo: AuthInfo | undefined
    if (this.#gate) {
      const gated = await this.#gate(request)
      if (gated instanceof Response) return gated
      authInfo = gated
    }

    const connection = await this.params.onConnect(
      {
        accept: JSON_CONTENT_TYPE,
        contentType: JSON_CONTENT_TYPE,
        data: request,
        protocolVersion: ProtocolVersion.v1,
        type: ConnectionType.Unidirectional,
      },
      ...(authInfo ? [provision(mcpAuthInfo, authInfo)] : []),
    )

    try {
      this.#states.set(request, { connection, nextCallId: 0 })
      return await this.#mcp.fetch(request, { authInfo })
    } finally {
      this.#states.delete(request)
      await connection[Symbol.asyncDispose]()
    }
  }

  private async createServer(ctx: McpRequestContext): Promise<McpServer> {
    const state = ctx.requestInfo && this.#states.get(ctx.requestInfo)
    if (!state) {
      // The SDK always passes the original Request back; if this ever
      // breaks, fail loudly instead of dispatching without a connection
      throw new Error('MCP request state not found for the current request')
    }

    const { serverInfo, instructions } = this.options
    const server = new McpServer(
      {
        name: serverInfo.name,
        version: serverInfo.version,
        ...(serverInfo.title === undefined ? {} : { title: serverInfo.title }),
      },
      instructions === undefined ? undefined : { instructions },
    )

    for (const [name, config] of this.#tools) {
      const { input, description, title } = await this.resolveTool(
        state.connection,
        name,
        config,
      )

      server.registerTool(
        name,
        {
          description,
          ...(title === undefined ? {} : { title }),
          inputSchema: fromJsonSchema(input.schema as any),
          ...(config.annotations === undefined
            ? {}
            : { annotations: config.annotations }),
        },
        async (args: unknown, extra: any): Promise<CallToolResult> => {
          try {
            const result = await this.params.onRpc(
              state.connection,
              {
                callId: state.nextCallId++,
                payload: input.kind === 'none' ? undefined : args,
                procedure: config.procedure,
              },
              extra?.signal ?? new AbortController().signal,
            )

            const structured =
              result !== null &&
              typeof result === 'object' &&
              !Array.isArray(result)
                ? (result as Record<string, unknown>)
                : undefined
            return {
              content: [{ type: 'text', text: JSON.stringify(result ?? null) }],
              ...(structured === undefined
                ? {}
                : { structuredContent: structured }),
              isError: false,
            }
          } catch (error) {
            // Execution failures are tool results, not protocol errors —
            // agents are expected to read and react to them
            const message =
              error instanceof ProtocolError
                ? error.message || error.code
                : 'Tool execution failed'
            if (!(error instanceof ProtocolError)) console.error(error)
            return {
              content: [{ type: 'text', text: message }],
              isError: true,
            }
          }
        },
      )
    }

    return server
  }

  /** Resolve the procedure behind a tool and derive its schema/description. */
  private async resolveTool(
    connection: GatewayConnection,
    name: string,
    config: McpToolConfig,
  ) {
    let resolved: McpResolvedProcedure
    try {
      resolved = await this.params.resolve(connection, config.procedure)
    } catch (cause) {
      throw new McpConfigError(
        `MCP tool "${name}": procedure "${config.procedure}" is not registered`,
        { cause },
      )
    }
    if (resolved.stream) {
      throw new McpConfigError(
        `MCP tool "${name}": stream procedure "${config.procedure}" cannot be a tool`,
      )
    }
    const contract = resolved.procedure.contract
    const description = config.description ?? contract.description
    if (!description) {
      throw new McpConfigError(
        `MCP tool "${name}": a description is required (set it on the tool ` +
          'config or the procedure contract)',
      )
    }
    let input: ToolInputSchema
    try {
      input = emitToolInputSchema(contract.input)
    } catch (cause) {
      throw new McpConfigError(
        `MCP tool "${name}": cannot derive an input schema for "${config.procedure}"`,
        { cause },
      )
    }
    return {
      input,
      description,
      title: config.title ?? contract.title,
    }
  }
}
