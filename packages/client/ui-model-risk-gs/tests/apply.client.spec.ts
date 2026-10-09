// @vitest-environment jsdom
/** Loader composition registers model-row decoration and a session dialog host, then disposes both and the selection guard. */
import { expect } from 'vitest'
import { ClientRoster, createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { apply as hostApply } from '../src/index.ts'
import type { ModelRiskInjected } from '../src/client/ModelRisk.tsx'
import { NS } from '../src/client/locale.ts'

const packageName = '@deepseek-ai/dsh-client-ui-model-risk-gs'
const it = createClientTest({
  roster: ClientRoster.of([
    ...webApp.rows,
    {
      name: packageName,
      inject: ['@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-client-ui-model-selection'],
      immediately: false,
    },
  ]),
})

it('occupies the composer activity seat and leaves on dispose', async ({ start }) => {
  const client = await start()
  const entries = client.ctx.slots.entries('conversation.input.activity')
  expect(entries).toHaveLength(1)
  expect(entries[0]!.locale).toBe(NS)
  const face = entries[0]!.inject?.() as ModelRiskInjected | undefined
  expect(face).toBeDefined()
  expect(face!.controller).toBeDefined()
  expect(client.ctx.slots.entries('model.option.accessory')).toHaveLength(1)
  expect(client.ctx.modelDirectories.requiresAuthorization).toBe(true)
  await client.unload(packageName)
  await client.flush()
  expect(client.ctx.slots.entries('conversation.input.activity')).toEqual([])
  expect(client.ctx.slots.entries('model.option.accessory')).toEqual([])
  expect(client.ctx.modelDirectories.requiresAuthorization).toBe(false)
}, 60_000)

it('host apply registers nothing', () => {
  hostApply()
})
