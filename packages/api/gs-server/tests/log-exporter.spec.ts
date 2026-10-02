/** Log uploader: threshold, batching, masking, drop-oldest, and shutdown flush. */
import { expect, it, vi } from 'vitest'
import type { Message } from '@deepseek-ai/cordis'
import type { GsRequest, GsSessionTokenSource } from '../src/client.ts'
import { GS_LOG_QUEUE_LIMIT, GsLogExporter, type GsClientLogRecord } from '../src/log-exporter.ts'
import { maskSecrets } from '../src/mask-secrets.ts'

function session(token: string | undefined = 'at-1'): GsSessionTokenSource {
  return { accessToken: () => token, refreshAccessToken: () => Promise.resolve('at-2') }
}

function message(type: Message['type'], text: string): Message {
  return { sn: 1, ts: 1000, name: 'gs-server', type, level: 1, args: [text] }
}

/** Parse the JSON body of one captured gateway call. */
function bodyOf(init: RequestInit): { logs: GsClientLogRecord[] } {
  return JSON.parse(typeof init.body === 'string' ? init.body : '{}') as { logs: GsClientLogRecord[] }
}

function posted(bodies: { logs: GsClientLogRecord[] }[]): { request: GsRequest } {
  const request: GsRequest = async (_url, init) => {
    bodies.push(bodyOf(init))
    return new Response(JSON.stringify({ ok: true, count: 1 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }
  return { request }
}

it('buffers messages above the threshold and flushes one masked batch', async () => {
  const bodies: { logs: GsClientLogRecord[] }[] = []
  const exporter = new GsLogExporter({
    endpoint: () => 'http://127.0.0.1:8151/gsworker',
    session: session(),
    request: posted(bodies).request,
    threshold: 'info',
  })
  try {
    exporter.export(message('debug', 'hidden'))
    exporter.export(message('info', 'token=abc123 and Bearer abcdefghijklmnop'))
    exporter.export(message('error', 'boom'))
    await exporter.flush()
    expect(bodies).toHaveLength(1)
    const logs = bodies[0]!.logs
    expect(logs.map(record => record.level)).toEqual(['info', 'error'])
    expect(logs[0]?.message).not.toContain('abc123')
    expect(logs[0]?.message).not.toContain('abcdefghijklmnop')
    expect(logs[0]?.scope).toBe('gs-server')
  } finally {
    await exporter.close()
  }
})

it('drops the oldest records past the queue limit and warns once', async () => {
  const localLog = vi.fn()
  const request: GsRequest = async () => new Response(JSON.stringify({ ok: true, count: 0 }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  const exporter = new GsLogExporter({
    endpoint: () => 'http://127.0.0.1:8151/gsworker',
    session: session(),
    request,
    localLog,
  })
  try {
    // The first flush drains synchronously up to the batch limit and stays in
    // flight across the synchronous loop, so the queue can reach the cap.
    for (let index = 0; index < GS_LOG_QUEUE_LIMIT + 100; index++) {
      exporter.export(message('info', `line-${String(index)}`))
    }
    const warns = localLog.mock.calls.filter(([level]) => level === 'warn')
    expect(warns).toHaveLength(1)
  } finally {
    await exporter.close()
  }
  const lastBatch = localLog.mock.calls.some(([, line]) => String(line).includes('dropped'))
  expect(lastBatch).toBe(false)
})

it('discards a failed batch without retry and leaves a debug note', async () => {
  const localLog = vi.fn()
  const request: GsRequest = async () => { throw new TypeError('offline') }
  const exporter = new GsLogExporter({
    endpoint: () => 'http://127.0.0.1:8151/gsworker',
    session: session(),
    request,
    localLog,
  })
  try {
    exporter.export(message('warn', 'lost'))
    await exporter.flush()
    expect(localLog).toHaveBeenCalledWith('debug', expect.stringContaining('dropped 1 client log record(s)'))
  } finally {
    await exporter.close()
  }
})

it('close flushes the remainder and ignores later exports', async () => {
  const bodies: { logs: GsClientLogRecord[] }[] = []
  const exporter = new GsLogExporter({
    endpoint: () => 'http://127.0.0.1:8151/gsworker',
    session: session(),
    request: posted(bodies).request,
  })
  exporter.export(message('info', 'tail'))
  await exporter.close()
  exporter.export(message('info', 'late'))
  expect(bodies.flatMap(body => body.logs.map(record => record.message))).toEqual(['tail'])
  await exporter.close() // idempotent
})

it('masks credentials, URLs, and bearer tokens in rendered lines', () => {
  expect(maskSecrets('Authorization: Bearer abc.def.ghi')).toBe('Authorization: Bearer ****')
  expect(maskSecrets('Cookie: session=abc; other=1')).toBe('Cookie: ****')
  expect(maskSecrets('GET https://user:pw@example.com/x?token=t&ok=1')).toContain('https://****:****@example.com/x?token=****&ok=1')
  expect(maskSecrets('{"password":"p4ss"}')).toBe('{"password":"****"}')
  expect(maskSecrets('key sk-abcdefgh12345678 here')).toContain('sk-****')
})
