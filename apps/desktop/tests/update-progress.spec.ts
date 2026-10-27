/** Progress copy uses measured bytes and explicit local phases in both shell locales. */
import { expect, it } from 'vitest'
import { desktopUpdateProgress } from '../src/update-progress.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { DesktopUpdateState } from '../src/ipc.ts'

it.each(['en', 'zh-CN'])('records download, verification, preparation and restart progress: %s', async (language) => {
  const messages = resolveDesktopLocale(language).messages
  const states: DesktopUpdateState[] = [
    { phase: 'downloading' }, { phase: 'downloading', percent: 48.9 },
    { phase: 'verifying', percent: 100 }, { phase: 'preparing' }, { phase: 'installing' },
  ]
  await expect(JSON.stringify(states.map(state => desktopUpdateProgress(state, messages)), null, 2) + '\n')
    .toMatchFileSnapshot(`./expected/update-progress-${language}.json`)
  for (const phase of ['idle', 'checking', 'available', 'ready', 'error'] as const) {
    expect(desktopUpdateProgress({ phase }, messages)).toBeUndefined()
  }
})
