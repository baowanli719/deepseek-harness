import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { installGsUpdatePublisher } from '../src/gs-update-publisher.ts'

it('signals changed releases without credentials and ignores repeated config pulls', async () => {
  const ctx = new Context()
  const publish = vi.fn()
  installGsUpdatePublisher(ctx, publish)
  const config = { version: 1, agent: { sandboxProfile: 'workspace-write', approvalPolicy: 'ask', dataClass: 'internal' } as const,
    features: { customModel: false }, settingsPages: {}, permissions: { allowSubmit: true, allowExternalSkillInstall: false },
    skills: {}, models: null, notice: null, appUpdate: { version: '2.2.0', downloads: { windowsX64: 'https://updates.example/worker.exe' } } }
  try {
    ctx.emit('gs-server/client-config-changed', config)
    ctx.emit('gs-server/client-config-changed', { ...config, version: 2 })
    expect(publish.mock.calls).toEqual([[]])
    ctx.emit('gs-server/client-config-changed', { ...config, appUpdate: { ...config.appUpdate, notes: ['Updated release notes'] } })
    ctx.emit('gs-server/client-config-changed', { ...config, appUpdate: null })
    expect(publish.mock.calls).toEqual([[], [], []])
  } finally {
    await ctx.fiber.dispose()
  }
})
