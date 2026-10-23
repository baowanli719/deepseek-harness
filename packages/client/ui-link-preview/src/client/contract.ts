/** Providers own authentication and transport; the reader owns presentation. */

/** One text source returned by a link provider, never persisted by the reader. */
export interface LinkPreviewDocument {
  /** Human-readable title; null uses the reader's localized default. */
  readonly title: string | null
  /** Markdown or plain source text, including any provider fallback for malformed formatting. */
  readonly content: string
  /** Whether the provider reports that the returned text is incomplete. */
  readonly truncated: boolean
}

/** Read outcomes shared by providers with different authentication systems. */
export type LinkPreviewResult =
  | { readonly status: 'ok'; readonly document: LinkPreviewDocument }
  | { readonly status: 'unauthorized' | 'forbidden' | 'source-mismatch' | 'not-found' | 'unavailable' | 'failed' }

/** A provider recognizes its URLs and reads them through its own authenticated Host adapter. */
export interface LinkPreviewProvider {
  /** Unique contribution name; a second registration with the same name fails. */
  readonly name: string
  /**
   * Recognize a URL without fetching it. The Host must independently validate the destination.
   * @param url - Absolute HTTP(S) link.
   * @returns whether this provider claims it.
   */
  readonly accepts: (url: URL) => boolean
  /**
   * Read source text without exposing credentials to the browser.
   * @param url - Selected link, revalidated by the Host adapter.
   * @param signal - Aborted when the reader closes, reloads, or changes its source.
   * @returns normalized content or a reader-visible failure.
   */
  readonly read: (url: string, signal: AbortSignal) => Promise<LinkPreviewResult>
}

/** Registration face used by authentication-specific Client plugins. */
export interface LinkPreviews {
  /**
   * Register a provider in first-match order.
   * @param provider - URL recognition and authenticated reading callbacks.
   * @returns disposer removing only this registration.
   */
  register(provider: LinkPreviewProvider): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Authenticated and other application-owned source readers. */
    linkPreviews: LinkPreviews
  }
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Only source identity persists in the Sidebar layout; content and tokens do not. */
    'link-preview': { readonly provider: string; readonly url: string }
  }
}
