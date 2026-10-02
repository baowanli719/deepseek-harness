/**
 * Stdio MCP server bridging local image files to the server-side vision model.
 *
 * Spawned by the gs-vision-bridge plugin through the mcp-client stdio
 * transport with the loopback model-gateway proxy coordinates injected
 * through environment variables; the child never sees the gsclaw-server
 * session or provider credentials, only the per-boot proxy placeholder token.
 * Image bytes travel as chat-completions data URIs:
 * child -> loopback proxy -> gsclaw-server /api/v1/llm gateway -> upstream.
 *
 * @module @deepseek-ai/dsh-gs-app/mcp-vision-server
 */

import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

/** Raw image ceiling: base64 inflation plus the message envelope must stay under the 4 MiB caps on both proxy hops. */
export const MAX_IMAGE_FILE_BYTES = 2_500_000
/** Default ceiling for the vision model's answer when the caller passes no max_tokens. */
export const DEFAULT_MAX_TOKENS = 4096
/** Absolute ceiling accepted for the max_tokens argument. */
export const MAX_TOKENS_CEILING = 8192
/** Leaves headroom under the 120 s upstream gateway ceiling for the mcp-client tool-call timeout. */
export const REQUEST_TIMEOUT_MS = 110_000

/** Loopback proxy coordinates injected into the child; the server chooses the vision model. */
export interface VisionProxyConfig {
  readonly origin: string
  readonly token: string
}

/**
 * Read the injected proxy coordinates; every missing required variable is reported at once.
 * @param environment - process environment to read.
 * @returns the resolved proxy coordinates.
 * @throws {Error} listing every missing required variable.
 */
export function resolveVisionProxyConfig(environment: NodeJS.ProcessEnv): VisionProxyConfig {
  const missing: string[] = []
  const origin = environment.VISION_PROXY_ORIGIN ?? ''
  const token = environment.VISION_PROXY_TOKEN ?? ''
  if (origin.length === 0) missing.push('VISION_PROXY_ORIGIN')
  if (token.length === 0) missing.push('VISION_PROXY_TOKEN')
  if (missing.length > 0) {
    throw new Error(`mcp-vision-server: missing required environment: ${missing.join(', ')}`)
  }
  return {
    origin: origin.replace(/\/+$/u, ''),
    token,
  }
}

/**
 * Sniff the image format from magic bytes.
 * @param head - leading bytes of the file; at least 12 bytes cover every supported signature.
 * @returns the MIME type for PNG/JPEG/GIF/WebP, or undefined for anything else.
 */
export function detectImageMime(head: Buffer): string | undefined {
  if (head.length >= 4 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 6 && head.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (head.length >= 6 && head.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (head.length >= 12
    && head.subarray(0, 4).toString('ascii') === 'RIFF'
    && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

/** Model-readable failure of the vision tool; every message is safe to show the user. */
export class VisionToolError extends Error {}

/**
 * Load one local image as a data URI, enforcing the format allowlist and the size ceiling.
 * @param path - image file path to read.
 * @returns the data URI, detected MIME type, and raw byte length.
 * @throws {VisionToolError} when the file is unreadable, oversized, or not a supported image.
 */
export async function readImageAsDataUri(path: string): Promise<{ dataUri: string; mime: string; bytes: number }> {
  let stats
  try {
    stats = await stat(path)
  } catch {
    throw new VisionToolError(`图片文件不存在或不可读: ${path}`)
  }
  if (!stats.isFile()) throw new VisionToolError(`路径不是文件: ${path}`)
  if (stats.size > MAX_IMAGE_FILE_BYTES) {
    throw new VisionToolError(
      `图片 ${String(stats.size)} 字节超过 ${String(MAX_IMAGE_FILE_BYTES)} 字节上限，请先压缩或缩小后再分析`,
    )
  }
  const buffer = await readFile(path)
  const mime = detectImageMime(buffer.subarray(0, 12))
  if (mime === undefined) {
    throw new VisionToolError(`无法识别的图片格式（仅支持 PNG/JPEG/WebP/GIF）: ${path}`)
  }
  return { dataUri: `data:${mime};base64,${buffer.toString('base64')}`, mime, bytes: buffer.length }
}

/** One multimodal chat-completions request against the loopback proxy. */
export interface ChatCompletionsRequest {
  readonly prompt: string
  readonly dataUri: string
  readonly maxTokens: number
}

/**
 * Multimodal chat body; no system message — the upstream gateway accepts at most one leading system message.
 * @param request - analysis prompt, image data URI, and token ceiling.
 * @returns the JSON body posted to `/vision/chat/completions`.
 */
export function buildChatCompletionsBody(request: ChatCompletionsRequest): Record<string, unknown> {
  return {
    stream: false,
    max_tokens: request.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: request.prompt },
          { type: 'image_url', image_url: { url: request.dataUri } },
        ],
      },
    ],
  }
}

/**
 * Extract the assistant text from a chat-completions payload, tolerating string or part-array content.
 * @param payload - parsed response JSON.
 * @returns the trimmed assistant text, or an empty string when absent.
 */
export function extractAssistantText(payload: unknown): string {
  if (payload === null || typeof payload !== 'object') return ''
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return ''
  const first: unknown = choices[0]
  if (first === null || typeof first !== 'object') return ''
  const content = (first as { message?: { content?: unknown } }).message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map(part => (part !== null && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : ''))
      .filter(text => text.length > 0)
      .join('\n')
      .trim()
  }
  return ''
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>

async function readErrorDetail(response: Response): Promise<{ code?: string | undefined; message?: string | undefined }> {
  try {
    const payload: unknown = await response.json()
    if (payload !== null && typeof payload === 'object') {
      const record = payload as { code?: unknown; message?: unknown; error?: { message?: unknown } }
      return {
        code: typeof record.code === 'string' ? record.code : undefined,
        message: typeof record.message === 'string'
          ? record.message
          : typeof record.error?.message === 'string' ? record.error.message : undefined,
      }
    }
  } catch {
    // Non-JSON error bodies fall through to the generic mapping.
  }
  return {}
}

/**
 * Run one vision analysis through the loopback proxy and map every failure to a model-readable message.
 * @param config - proxy coordinates.
 * @param request - model id, prompt, image data URI, and token ceiling.
 * @param fetchImpl - fetch implementation; tests inject a stub.
 * @returns the vision model's analysis text.
 * @throws {VisionToolError} with a model-readable message for every failure mode.
 */
export async function analyzeImageWithVisionModel(
  config: VisionProxyConfig,
  request: ChatCompletionsRequest,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  let response: Response
  try {
    response = await fetchImpl(`${config.origin}/vision/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(buildChatCompletionsBody(request)),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (cause: unknown) {
    const aborted = cause instanceof Error && cause.name === 'TimeoutError'
    throw new VisionToolError(aborted
      ? '视觉模型请求超时，请稍后重试'
      : `无法连接本地 LLM 代理: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
  if (!response.ok) {
    const detail = await readErrorDetail(response)
    if (response.status === 401) throw new VisionToolError('gsclaw-server 会话已失效，请重新登录后再试')
    if (response.status === 413) throw new VisionToolError('图片过大，请先压缩或缩小后再分析')
    if (detail.code === 'vision_not_configured') {
      throw new VisionToolError('服务端尚未启用图片理解能力')
    }
    throw new VisionToolError(`视觉模型请求失败 (HTTP ${String(response.status)}): ${detail.message ?? '未知错误'}`)
  }
  const text = extractAssistantText(await response.json())
  if (text.length === 0) throw new VisionToolError('视觉模型没有返回可用的分析结果')
  return text
}

/** Validated arguments of the analyze_image MCP tool. */
export interface AnalyzeImageArguments {
  readonly path: string
  readonly prompt: string
  readonly max_tokens?: number | undefined
}

/** MCP tool result payload returned by the analyze_image handler. */
export interface AnalyzeImageResult {
  readonly [key: string]: unknown
  readonly content: { readonly type: 'text'; readonly text: string }[]
  readonly isError?: boolean
}

/**
 * Tool handler shared by the MCP registration and the unit tests.
 * @param config - proxy coordinates.
 * @param args - validated tool arguments.
 * @param fetchImpl - fetch implementation; tests inject a stub.
 * @returns the analysis text block, or an isError text block instead of throwing.
 */
export async function handleAnalyzeImage(
  config: VisionProxyConfig,
  args: AnalyzeImageArguments,
  fetchImpl?: FetchLike,
): Promise<AnalyzeImageResult> {
  try {
    const image = await readImageAsDataUri(resolve(args.path))
    const text = await analyzeImageWithVisionModel(config, {
      prompt: args.prompt,
      dataUri: image.dataUri,
      maxTokens: args.max_tokens ?? DEFAULT_MAX_TOKENS,
    }, fetchImpl)
    return { content: [{ type: 'text', text }] }
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

/** Build the MCP server exposing the analyze_image tool over the given proxy coordinates. */
function createVisionServer(config: VisionProxyConfig): McpServer {
  const server = new McpServer({ name: 'dsh-vision', version: '0.1.0' })
  server.registerTool('analyze_image', {
    title: 'Analyze Image',
    description:
      '分析一张本地图片的内容（物体、文字、布局等）。传入图片文件的绝对路径和分析要求，返回视觉模型的文字分析结果。仅支持 PNG/JPEG/WebP/GIF，文件不能超过 2.5MB。',
    inputSchema: z.object({
      path: z.string().min(1).describe('本地图片文件的绝对路径'),
      prompt: z.string().min(1).describe('对图片的分析要求，例如「描述画面内容」或「提取图中的文字」'),
      max_tokens: z.number().int().min(1).max(MAX_TOKENS_CEILING).optional()
        .describe(`分析结果的最大 token 数，默认 ${String(DEFAULT_MAX_TOKENS)}`),
    }),
    annotations: { readOnlyHint: true },
  }, async args => await handleAnalyzeImage(config, args))
  return server
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    // Resolve eagerly so a missing coordinate fails the child at spawn, not on
    // the first MCP connection.
    const config = resolveVisionProxyConfig(process.env)
    serveStdio(() => createVisionServer(config))
  } catch (cause: unknown) {
    process.stderr.write(`mcp-vision-server: ${cause instanceof Error ? cause.message : String(cause)}\n`)
    process.exitCode = 1
  }
}
