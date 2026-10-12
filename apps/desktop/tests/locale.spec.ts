import { describe, expect, it } from 'vitest'
import { en, formatDesktopMessage, resolveDesktopLocale, resolveDesktopStartupLocale, withDesktopProductName, zh } from '../src/locale.ts'

describe('desktop locale dictionaries', () => {
  it('uses the server brand in native About, tray, and quit copy without changing the stock dictionary', () => {
    const branded = withDesktopProductName(resolveDesktopLocale('zh'), '国盛办公AI')
    expect(branded.messages.aboutProduct).toBe('国盛办公AI')
    expect(branded.messages.aboutMenu).toBe('关于 国盛办公AI')
    expect(branded.messages.quitTitle).not.toContain('DeepSeek Harness')
    expect(branded.messages.aboutVersion).toBe(zh.aboutVersion)
    expect(resolveDesktopLocale('zh').messages.aboutProduct).toBe('DeepSeek Harness')
  })
  it('ships the same key set in English and Chinese', () => {
    expect(Object.keys(zh)).toEqual(Object.keys(en))
    expect(resolveDesktopLocale('zh-Hans-CN').messages).toEqual(zh)
    expect(resolveDesktopLocale('en-US').messages).toEqual(en)
    expect(resolveDesktopLocale('fr-FR').messages).toEqual(en)
  })

  it('formats named values without consuming unknown placeholders', () => {
    expect(formatDesktopMessage('{name}@{version} {missing}', { name: 'plugin', version: '1.2.3' }))
      .toBe('plugin@1.2.3 {missing}')
  })

  it('prefers an explicit supported choice, then the first supported system language', () => {
    expect(resolveDesktopStartupLocale('zh', ['en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale('EN', ['zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP', 'zh-Hant', 'en-US']).id).toBe('zh-CN')
    expect(resolveDesktopStartupLocale(null, ['en-US', 'zh-CN']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, ['ja-JP']).id).toBe('en')
    expect(resolveDesktopStartupLocale(null, []).id).toBe('en')
    expect(resolveDesktopStartupLocale('ja', ['zh-CN']).id).toBe('zh-CN')
  })

})
