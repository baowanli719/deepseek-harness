/** GS-authenticated source adapter; the Host retains all gateway tokens. */
import type { LinkPreviewProvider, LinkPreviewResult } from '@deepseek-ai/dsh-client-ui-link-preview/client'

/**
 * Bind GS policy links to the shared reader.
 * @returns source provider over the same-origin Host proxy.
 */
export function createGsLinkPreviewProvider(): LinkPreviewProvider {
  return {
    name: 'gs-zhidu',
    accepts: url => /\/api\/v1\/zhidu\/files\/\d{1,25}$/u.test(url.pathname) && url.search === '' && url.hash === '',
    read: async (url, signal): Promise<LinkPreviewResult> => {
      const response = await fetch(`api/gs-server/link-preview?url=${encodeURIComponent(url)}`, {
        credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
      })
      if (!response.ok) {
        if (response.status === 409) {
          const error: unknown = await response.json().catch(() => null)
          return { status: typeof error === 'object' && error !== null && 'code' in error && error.code === 'source_endpoint_mismatch'
            ? 'source-mismatch' : 'failed' }
        }
        return { status: response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden'
          : response.status === 404 ? 'not-found' : 'failed' }
      }
      const value: unknown = await response.json()
      if (typeof value !== 'object' || value === null || !('content' in value) || typeof value.content !== 'string'
        || !('truncated' in value) || typeof value.truncated !== 'boolean'
        || !('fileName' in value) || (value.fileName !== null && typeof value.fileName !== 'string')) {
        return { status: 'failed' }
      }
      return { status: 'ok', document: { title: value.fileName, content: value.content, truncated: value.truncated } }
    },
  }
}
