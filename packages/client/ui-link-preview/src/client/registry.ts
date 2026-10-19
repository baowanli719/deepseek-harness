/** Reversible provider registrations with live invalidation for open readers. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LinkPreviewProvider, LinkPreviewResult, LinkPreviews } from './contract.ts'

/** Provider registry private to one Client plugin lifetime. */
export class LinkPreviewRegistry implements LinkPreviews {
  private readonly providers = new Map<string, LinkPreviewProvider>()
  /** Registration revision, exposed without provider callbacks to mounted readers. */
  readonly source = createSnapshotStore(0)

  /** @param provider - uniquely named reader. @returns registration disposer. */
  register(provider: LinkPreviewProvider): () => void {
    if (this.providers.has(provider.name)) {
      throw new Error(`Link preview provider already registered: ${provider.name}`)
    }
    this.providers.set(provider.name, provider)
    this.source.set(this.source.getSnapshot() + 1)
    return () => {
      if (this.providers.get(provider.name) !== provider) return
      this.providers.delete(provider.name)
      this.source.set(this.source.getSnapshot() + 1)
    }
  }

  /**
   * Find the first provider accepting an ordinary HTTP(S) destination.
   * @param value - Selected link.
   * @returns matching provider, or undefined for native navigation.
   */
  resolve(value: string): LinkPreviewProvider | undefined {
    let url: URL
    try { url = new URL(value) } catch { return undefined }
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') return undefined
    return [...this.providers.values()].find(provider => provider.accepts(url))
  }

  /**
   * Read only while the recorded provider still owns the source.
   * @param name - Provider recorded by the tab.
   * @param url - Source URL.
   * @param signal - Reader lifetime.
   * @returns current provider result, or unavailable after registration changes.
   */
  async read(name: string, url: string, signal: AbortSignal): Promise<LinkPreviewResult> {
    const provider = this.resolve(url)
    if (provider?.name !== name) return { status: 'unavailable' }
    return provider.read(url, signal)
  }
}
