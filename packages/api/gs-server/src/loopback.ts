/**
 * Same-origin loopback guard for the private gs-server routes.
 *
 * The `/api/gs-server/*` routes answer only requests that arrive over the
 * loopback socket with a Host header pinned to the expected origin and
 * browser fetch metadata consistent with a same-origin call, so a LAN peer or
 * a cross-site browser page cannot drive the Host-owned credential channel.
 *
 * @module
 */

import type { IncomingMessage } from 'node:http'

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]'
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  if (address === '::1' || address === '127.0.0.1') return true
  if (address.startsWith('::ffff:')) {
    const mapped = address.slice('::ffff:'.length)
    return mapped.startsWith('127.')
  }
  return address.startsWith('127.')
}

function expectedLoopbackOrigin(expectedOrigin: string): URL | undefined {
  try {
    const url = new URL(expectedOrigin)
    if (url.origin !== expectedOrigin || url.protocol !== 'http:'
      || url.username !== '' || url.password !== ''
      || !isLoopbackHostname(url.hostname)) return undefined
    return url
  } catch {
    return undefined
  }
}

function exactHeaderOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    const url = new URL(value)
    return url.origin === value ? value : undefined
  } catch {
    return undefined
  }
}

function referrerOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}

/**
 * Require the actual socket and Host to stay on the configured loopback
 * origin. A mutating request must carry the exact Origin. A read-only browser
 * GET may use the standard same-origin fetch metadata plus its same-origin
 * referrer, because browsers commonly omit Origin on same-origin GET
 * requests.
 * @param req - the incoming request under judgment.
 * @param expectedOrigin - loopback origin the routes belong to.
 * @param mutating - whether the request changes server or credential state.
 * @returns true when the request may proceed.
 */
export function isSameOriginLoopbackRequest(
  req: IncomingMessage,
  expectedOrigin: string,
  mutating: boolean,
): boolean {
  const expected = expectedLoopbackOrigin(expectedOrigin)
  if (expected === undefined || !isLoopbackAddress(req.socket.remoteAddress)) return false
  if (req.headers.host?.toLowerCase() !== expected.host.toLowerCase()) return false
  if (exactHeaderOrigin(req.headers.origin) === expected.origin) {
    return req.headers['sec-fetch-site'] === undefined || req.headers['sec-fetch-site'] === 'same-origin'
  }
  if (mutating) return false
  return req.headers['sec-fetch-site'] === 'same-origin'
    && referrerOrigin(req.headers.referer) === expected.origin
}
