import { expect, it, vi } from 'vitest'
import { connectGsLogin } from '../src/gs-login-backend.ts'

it('uses the authenticated Host origin and private gs-server routes for password login', async () => {
  const send = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ status: 'signed-in' }), {
    headers: { 'content-type': 'application/json' },
  }))
  const backend = connectGsLogin('http://127.0.0.1:19387/?token=private', send)
  await backend.session()
  await backend.password({ username: 'alice', password: 'secret' })
  expect(send.mock.calls[0]?.[0]).toBe('http://127.0.0.1:19387/api/gs-server/session')
  expect(send.mock.calls[1]?.[0]).toBe('http://127.0.0.1:19387/api/gs-server/login')
  expect(send.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST', credentials: 'include', headers: { origin: 'http://127.0.0.1:19387', 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', password: 'secret' }),
  })
})

it('preserves lockout status and retry duration for the email-code form', async () => {
  const backend = connectGsLogin('http://127.0.0.1:19387/', async () => new Response(JSON.stringify({ error: 'locked', retryAfter: 45 }), { status: 429 }))
  await expect(backend.emailCode('alice')).rejects.toMatchObject({ status: 429, retryAfter: 45 })
})
