/**
 * gs-vision-bridge: host-plane plugin mounting the bundle-local vision MCP
 * server (`mcp-vision-server.ts`) through `@deepseek-ai/dsh-mcp-client`, so
 * the model gains the `mcp__<serverName>__analyze_image` tool backed by the
 * server-side vision model.
 *
 * A plain mcp-client config row cannot express this mount: the child script
 * path derives from this package's own module URL, and the per-boot loopback
 * proxy coordinates are runtime values provided by the `gsLlmGateway` service
 * (optional; read through `ctx.get`). When the gateway is absent the bridge
 * logs a warning and leaves the vision tool unmounted instead of failing the
 * boot — mirroring the desktop product's fail-soft mount.
 *
 * @module @deepseek-ai/dsh-gs-app/vision-bridge
 */

import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import type { GsLlmGateway } from '@deepseek-ai/dsh-llm-gs-gateway'

/** Stable Cordis plugin name. */
export const name = 'gs-vision-bridge'

/** The gateway is optional and read through `ctx.get`, so no declared injection. */
export const inject: string[] = []

/** Configuration for the vision MCP bridge. */
export interface Config {
  /** MCP server namespace; the tool appears as `mcp__<serverName>__analyze_image`. */
  readonly serverName: string
  /** Per-call timeout; stays above the vision server's own request timeout so its readable error wins. */
  readonly toolCallTimeoutMs: number
}

/** Input form of {@link Config}: every field optional, schema defaults apply. */
type ConfigInput = Partial<Config>

/** Runtime schema for {@link Config}. */
export const Config = z.object({
  serverName: z.string().pattern(/^[A-Za-z0-9_-]{1,32}$/).default('vision'),
  toolCallTimeoutMs: z.number().min(1).default(120_000),
}) as z<ConfigInput, Config>

/**
 * Resolve the sibling vision-server entry for plain Node: the built `.js`
 * under lib/, or the `.ts` source when the host itself runs from source.
 * @returns the absolute file path passed as the stdio child's argument.
 */
export function visionServerEntry(): string {
  const self = new URL(import.meta.url)
  return fileURLToPath(new URL(`./mcp-vision-server.${self.pathname.endsWith('.ts') ? 'ts' : 'js'}`, self))
}

/**
 * Mount the vision MCP server as one mcp-client stdio instance.
 * @param ctx - host context; the gateway service is read optionally from it.
 * @param config - resolved bridge configuration.
 * @returns readiness of the mount; the mcp-client child connection included.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const gateway: GsLlmGateway | undefined = ctx.get('gsLlmGateway')
  if (gateway === undefined) {
    ctx.logger.warn('gs-vision-bridge: gsLlmGateway service is unavailable; the vision MCP bridge stays unmounted')
    return
  }
  // The per-boot proxy token reaches only this child through the mcp-client
  // env carve-out; it never touches process.env or disk.
  await ctx.plugin(mcpClient, {
    transport: 'stdio',
    serverName: config.serverName,
    command: process.execPath,
    args: [visionServerEntry()],
    env: {
      VISION_PROXY_ORIGIN: gateway.origin,
      VISION_PROXY_TOKEN: gateway.token,
    },
    toolCallTimeoutMs: config.toolCallTimeoutMs,
    failOnStartupError: false,
  })
}
