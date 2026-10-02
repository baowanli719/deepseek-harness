/** Keychain storage keeps credentials out of argv and rejects modified ciphertext. */
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { expect, it, vi } from 'vitest'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))
import { macOsKeychainProtector } from '../src/protector.ts'

it('creates one Keychain master key over stdin and authenticates restored secrets', async () => {
  let key: string | undefined
  const inputs: string[] = []
  spawn.mockImplementation((_file: string, args: string[]) => {
    const events = new EventEmitter()
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let input = ''
    const stdin = new Writable({
      write(chunk, _encoding, callback) { input += String(chunk); callback() },
      final(callback) {
        inputs.push(input)
        queueMicrotask(() => {
          if (args[0] === '-i') key ??= /-w ([a-f\d]{64})/u.exec(input)?.[1]
          if (args[0] !== '-i' && key !== undefined) stdout.write(key)
          events.emit('close', key === undefined ? 44 : 0)
        })
        callback()
      },
    })
    return Object.assign(events, { stdout, stderr, stdin, kill: vi.fn() })
  })
  const protector = macOsKeychainProtector()
  const [first, second] = await Promise.all([protector.protect('refresh-a'), protector.protect('refresh-b')])
  expect(await protector.unprotect(first)).toBe('refresh-a')
  expect(await macOsKeychainProtector().unprotect(second)).toBe('refresh-b')
  expect(inputs.filter(input => input.includes('add-generic-password'))).toHaveLength(1)
  expect(JSON.stringify(spawn.mock.calls)).not.toContain(key)
  expect(JSON.stringify(spawn.mock.calls)).not.toContain('refresh-a')
  const tampered = Uint8Array.from(first)
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1
  await expect(protector.unprotect(tampered)).rejects.toThrow()
  await expect(protector.unprotect(new Uint8Array(4))).rejects.toThrow('Invalid sealed')
  spawn.mockReset()
})
