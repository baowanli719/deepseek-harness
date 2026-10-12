/**
 * gsclaw-server endpoint resolution.
 *
 * Precedence: runtime override persisted below the state directory wins, then
 * the environment seam for development and packaging, then the configured
 * deployment default. Plain HTTP is accepted only for literal loopback
 * addresses, localhost, and the exact shipped deployment endpoint; other
 * endpoints must use HTTPS.
 *
 * @module
 */

import { lstat, open, unlink } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Shipped Config default for the deployment endpoint. */
export const GS_DEFAULT_ENDPOINT = 'http://192.168.230.108:8151/gsclaw'

/** Environment variable overriding the configured endpoint for development. */
export const GS_ENDPOINT_ENV = 'GSCLAW_ENDPOINT'

/** Runtime override state location below the state directory. */
export const GS_ENDPOINT_RELATIVE_PATH = 'gs-endpoint.json'

/** Maximum override state bytes read before treating the file as corrupt. */
export const MAX_GS_ENDPOINT_STATE_BYTES = 4 * 1024

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

/** Failure raised when an endpoint value or its persisted state is unsafe. */
export class GsEndpointError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'GsEndpointError'
  }
}

/**
 * Return the exact runtime override path for one state directory.
 * @param stateDirectory - absolute directory holding gs-server state.
 * @returns the override state file path.
 */
export function gsEndpointStatePath(stateDirectory: string): string {
  if (stateDirectory.length === 0 || /[\0\r\n]/u.test(stateDirectory) || !isAbsolute(stateDirectory)) {
    throw new GsEndpointError('gs-server state directory must be an absolute path without control characters.')
  }
  return join(resolve(stateDirectory), GS_ENDPOINT_RELATIVE_PATH)
}

function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase()
  if (lower === 'localhost' || lower === '[::1]') return true
  return isIP(lower) === 4 && lower.startsWith('127.')
}

/**
 * Validate and normalize one endpoint URL.
 *
 * Only `http:`/`https:` authorities without credentials, query, or fragment
 * are accepted; the path is kept verbatim minus trailing slashes. Plain HTTP
 * is restricted to loopback and the exact shipped deployment endpoint.
 * @param value - candidate endpoint URL.
 * @returns the normalized endpoint.
 */
export function assertGsEndpoint(value: string): string {
  const trimmed = value.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new GsEndpointError('gsclaw-server endpoint must be an absolute http(s) URL.')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new GsEndpointError('gsclaw-server endpoint must use http or https.')
  }
  if (url.username !== '' || url.password !== '') {
    throw new GsEndpointError('gsclaw-server endpoint must not embed credentials.')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new GsEndpointError('gsclaw-server endpoint must not carry a query or fragment.')
  }
  const endpoint = `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname) && endpoint !== GS_DEFAULT_ENDPOINT) {
    throw new GsEndpointError('gsclaw-server endpoint requires https outside loopback or the shipped deployment endpoint.')
  }
  return endpoint
}

/**
 * Resolve one override candidate, or undefined when absent or invalid.
 * @param value - candidate endpoint URL, or undefined.
 * @returns the normalized endpoint, or undefined.
 */
export function parseGsEndpointOverride(value: string | undefined): string | undefined {
  if (value === undefined || value.trim() === '') return undefined
  try {
    return assertGsEndpoint(value)
  } catch {
    return undefined
  }
}

/** Inputs for one endpoint store. */
export interface GsEndpointStoreOptions {
  /** Absolute state directory holding the runtime override. */
  readonly stateDir: string
  /** Environment override value; defaults to the GSCLAW_ENDPOINT seam. */
  readonly environment?: string | undefined
  /**
   * Configured deployment default applied when neither the persisted override
   * nor the environment speaks; validated at load so a misconfiguration fails
   * before any request resolves.
   */
  readonly fallback: string
}

/**
 * Runtime endpoint store. The persisted override is loaded once at startup;
 * `resolve()` stays synchronous so request paths never race the filesystem.
 */
export class GsEndpointStore {
  private override: string | undefined

  private constructor(
    private readonly statePath: string,
    private readonly environment: string | undefined,
    private readonly fallback: string,
    override: string | undefined,
  ) {
    this.override = override
  }

  /**
   * Load the persisted override, treating absent or corrupt state as none.
   * @param options - state directory, environment seam, and deployment default.
   * @returns the loaded store.
   */
  static async load(options: GsEndpointStoreOptions): Promise<GsEndpointStore> {
    const statePath = gsEndpointStatePath(options.stateDir)
    const candidate = options.environment ?? process.env[GS_ENDPOINT_ENV]
    const environment = candidate === undefined || candidate.trim() === '' ? undefined : assertGsEndpoint(candidate)
    const fallback = assertGsEndpoint(options.fallback)
    const persisted = await readPersistedEndpoint(statePath)
    return new GsEndpointStore(statePath, environment, fallback, persisted)
  }

  /**
   * Effective endpoint: persisted override, then environment, then the configured default.
   * @returns the effective endpoint.
   */
  resolve(): string {
    return this.override
      ?? parseGsEndpointOverride(this.environment)
      ?? this.fallback
  }

  /** Explicit runtime override currently persisted, if any. */
  get persistedOverride(): string | undefined {
    return this.override
  }

  /**
   * Validate and persist one runtime override.
   * @param value - new endpoint URL.
   * @returns the normalized persisted endpoint.
   */
  async setOverride(value: string): Promise<string> {
    const endpoint = assertGsEndpoint(value)
    await writeFileAtomic(this.statePath, `${JSON.stringify({ endpoint })}\n`, {
      mode: PRIVATE_FILE_MODE,
      dirMode: PRIVATE_DIRECTORY_MODE,
    })
    this.override = endpoint
    return endpoint
  }

  /** Drop the runtime override so environment and configured default apply again. */
  async clearOverride(): Promise<void> {
    this.override = undefined
    try {
      await unlink(this.statePath)
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new GsEndpointError('gsclaw-server endpoint override could not be removed.', { cause })
      }
    }
  }
}

async function readPersistedEndpoint(statePath: string): Promise<string | undefined> {
  let stat: Awaited<ReturnType<typeof lstat>>
  try {
    stat = await lstat(statePath)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new GsEndpointError('gsclaw-server endpoint state could not be inspected.', { cause })
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_GS_ENDPOINT_STATE_BYTES) return undefined

  const handle = await open(statePath, 'r')
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.size > MAX_GS_ENDPOINT_STATE_BYTES) return undefined
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new GsEndpointError('gsclaw-server endpoint state changed while it was being opened.')
    }
    const buffer = Buffer.alloc(MAX_GS_ENDPOINT_STATE_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0)
    if (bytesRead > MAX_GS_ENDPOINT_STATE_BYTES) return undefined
    const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const endpoint = (value as Record<string, unknown>).endpoint
    return typeof endpoint === 'string' ? parseGsEndpointOverride(endpoint) : undefined
  } catch (cause) {
    if (cause instanceof SyntaxError || cause instanceof TypeError) return undefined
    if (cause instanceof GsEndpointError) throw cause
    throw new GsEndpointError('gsclaw-server endpoint state could not be read safely.', { cause })
  } finally {
    await handle.close()
  }
}
