/** Exercise the real Windows token protector used after a gs-server login. */
import { expect, it } from 'vitest'
import { windowsDpapiProtector } from '../src/protector.ts'

const windowsIt = process.platform === 'win32' ? it : it.skip

windowsIt('seals and restores a refresh token with the current Windows user', async () => {
  const protector = windowsDpapiProtector()
  const token = 'gs-test-refresh-token-测试'
  const sealed = await protector.protect(token)
  expect(sealed.byteLength).toBeGreaterThan(0)
  expect(Buffer.from(sealed).toString('utf8')).not.toContain(token)
  await expect(protector.unprotect(sealed)).resolves.toBe(token)
})
