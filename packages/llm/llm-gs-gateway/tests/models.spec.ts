/** ClientConfig models → provider-profile planning and the token launch environment. */
import { describe, expect, it } from 'vitest'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  GS_LLM_GATEWAY_CREDENTIAL_REF,
  gsLlmGatewayLaunchEnvironment,
  planGsLlmGatewayModels,
} from '@deepseek-ai/dsh-llm-gs-gateway'
import type { GsModelsConfig } from '@deepseek-ai/dsh-gs-server'

const ORIGIN = 'http://127.0.0.1:43123'

function models(overrides: Partial<GsModelsConfig> = {}): GsModelsConfig {
  return {
    providers: {
      'gs-cloud': {
        api: 'openai-completions',
        models: [
          { id: 'qwen-max', name: 'Qwen Max', input: ['text', 'image'] },
          { id: 'qwen-lite' },
        ],
      },
      'gs-local': {
        api: 'openai-completions',
        models: [{ id: 'local-7b', input: ['text', 'audio'] }],
      },
    },
    defaultPrimary: 'gs-cloud/qwen-max',
    ...overrides,
  }
}

describe('planGsLlmGatewayModels', () => {
  it('plans sorted provider profiles routed through the proxy with the credential reference', () => {
    const plan = planGsLlmGatewayModels({ models: models(), proxyOrigin: ORIGIN })

    expect(plan.warnings).toEqual([])
    expect(Object.keys(plan.providers ?? {})).toEqual(['gs-cloud', 'gs-local'])
    expect(plan.providers?.['gs-cloud']).toEqual({
      displayName: 'gs-cloud',
      api: 'openai-completions',
      baseURL: `${ORIGIN}/v1/gs-cloud`,
      apiKeyEnv: GS_LLM_GATEWAY_CREDENTIAL_REF,
      // Session-affinity emission binds each adapter request to its session on
      // the loopback hop, so the proxy can judge the audit header.
      compat: { sendSessionAffinityHeaders: true, sessionAffinityFormat: 'openrouter' },
      models: [
        { id: 'qwen-max', name: 'Qwen Max', input: ['text', 'image'] },
        { id: 'qwen-lite' },
      ],
    })
    // Unservable modalities are filtered out; a model left with none still
    // serves text through the adapter default, so only declared values land.
    expect(plan.providers?.['gs-local']?.models).toEqual([{ id: 'local-7b', input: ['text'] }])
    expect(plan.defaultModel).toEqual({ provider: 'gs-cloud', model: 'qwen-max' })
  })

  it('keeps local settings with a warning when the server supplies no usable models', () => {
    for (const source of [null, undefined, { providers: {} }]) {
      const plan = planGsLlmGatewayModels({ models: source, proxyOrigin: ORIGIN })
      expect(plan.providers).toBeUndefined()
      expect(plan.defaultModel).toBeUndefined()
      expect(plan.warnings.length).toBeGreaterThan(0)
    }
  })

  it('skips providers outside the route grammar and unusable model ids with warnings', () => {
    const plan = planGsLlmGatewayModels({
      models: models({
        providers: {
          'gs-cloud': { api: 'openai-completions', models: [{ id: 'qwen-max' }, { id: 'bad id' }] },
          'bad/id': { api: 'openai-completions', models: [{ id: 'm' }] },
          empty: { api: 'openai-completions', models: [] },
        },
      }),
      proxyOrigin: ORIGIN,
    })

    expect(Object.keys(plan.providers ?? {})).toEqual(['gs-cloud'])
    expect(plan.providers?.['gs-cloud']?.models).toEqual([{ id: 'qwen-max' }])
    expect(plan.warnings.join('\n')).toContain('bad/id')
    expect(plan.warnings.join('\n')).toContain('bad id')
    expect(plan.warnings.join('\n')).toContain('empty')
  })

  it('falls back to the first supplied model when defaultPrimary does not resolve', () => {
    const missing = planGsLlmGatewayModels({
      models: models({ defaultPrimary: 'gs-cloud/no-such-model' }),
      proxyOrigin: ORIGIN,
    })
    expect(missing.defaultModel).toEqual({ provider: 'gs-cloud', model: 'qwen-max' })
    expect(missing.warnings.join('\n')).toContain('gs-cloud/no-such-model')

    const { defaultPrimary: _omitted, ...noDefault } = models()
    const absent = planGsLlmGatewayModels({ models: noDefault, proxyOrigin: ORIGIN })
    expect(absent.defaultModel).toEqual({ provider: 'gs-cloud', model: 'qwen-max' })
  })

  it('honors a custom credential reference', () => {
    const plan = planGsLlmGatewayModels({ models: models(), proxyOrigin: ORIGIN, credentialRef: 'CUSTOM_REF' })
    expect(plan.providers?.['gs-cloud']?.apiKeyEnv).toBe('CUSTOM_REF')
  })
})

describe('gsLlmGatewayLaunchEnvironment', () => {
  it('resolves the token from the process layer without touching other names', () => {
    const base = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { OTHER: 'process-value' } },
      { source: 'user-env', path: '/home/.env', values: { OTHER: 'user-value', REF_ONLY_USER: 'x' } },
    ])
    const wrapped = gsLlmGatewayLaunchEnvironment(base, 'the-token')

    expect(wrapped.get(GS_LLM_GATEWAY_CREDENTIAL_REF)).toEqual({ value: 'the-token', source: 'process' })
    expect(wrapped.getFrom(GS_LLM_GATEWAY_CREDENTIAL_REF, ['user-env'])).toBeUndefined()
    expect(wrapped.getFrom(GS_LLM_GATEWAY_CREDENTIAL_REF, ['process', 'user-env'])?.value).toBe('the-token')
    expect(wrapped.get('OTHER')?.value).toBe('process-value')
    expect(wrapped.getFrom('OTHER', ['user-env'])?.value).toBe('user-value')
    expect(wrapped.get('MISSING')).toBeUndefined()
  })
})
