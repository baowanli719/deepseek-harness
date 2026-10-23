// @vitest-environment jsdom
/** Reader dispatch and registration disposal without any credential-bearing transport. */
import { describe, expect, it, vi } from 'vitest'
import { LinkPreviewRegistry } from '../src/client/registry.ts'
import type { LinkPreviewProvider } from '../src/client/contract.ts'

const provider = (name: string): LinkPreviewProvider => ({
  name, accepts: url => url.hostname === 'source.test',
  read: vi.fn(async () => ({ status: 'ok' as const, document: { title: name, content: '原文', truncated: false } })),
})

describe('link preview providers', () => {
  it('dispatches in registration order and removes disposed providers from existing readers', async () => {
    const registry = new LinkPreviewRegistry()
    const first = provider('one')
    const second = provider('two')
    const remove = registry.register(first)
    const notify = vi.fn()
    const unsubscribe = registry.source.subscribe(notify)
    registry.register(second)
    expect(registry.resolve('https://source.test/file')).toBe(first)
    expect(() => registry.register(first)).toThrow('already registered')
    const signal = new AbortController().signal
    expect(await registry.read('one', 'https://source.test/file', signal)).toMatchObject({ status: 'ok' })
    expect(first.read).toHaveBeenCalledWith('https://source.test/file', signal)
    remove()
    remove()
    expect(registry.resolve('https://source.test/file')).toBe(second)
    expect(await registry.read('one', 'https://source.test/file', signal)).toEqual({ status: 'unavailable' })
    expect(second.read).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('leaves other links to the normal opener and refuses credential-bearing or active URLs', () => {
    const registry = new LinkPreviewRegistry()
    registry.register(provider('reader'))
    for (const url of ['not a URL', 'https://other.test/', 'https://user:pass@source.test/', 'javascript:alert(1)', 'file:///tmp/a']) {
      expect(registry.resolve(url)).toBeUndefined()
    }
    expect(registry.resolve('http://source.test/a')?.name).toBe('reader')
  })
})
