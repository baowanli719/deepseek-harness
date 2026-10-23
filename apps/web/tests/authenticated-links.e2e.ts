/** Recorded source links through the shipped Web UI and GS reader adapter. */
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compareOrRefreshGolden, launchWebScaffold, seedSession, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/authenticated-links', import.meta.url))
const EXPECTED = fileURLToPath(new URL('./expected/authenticated-links/reader.expected.md', import.meta.url))
const MODE = webSnapshotMode()
const CONTENT = '# Travel expense policy\n\n| Category | Limit |\n| --- | --- |\n| Train | Standard fare |\n\n> Employees must retain receipts.\n\nSee [the original policy][source].\n\n[source]: https://gs.example.test/gsclaw/api/v1/zhidu/files/1234567890123456789\n\n<script>literal source</script>'

describe('web: authenticated source links', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let status = 200
  let truncated = false

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      extraOverlayPath: [
        fileURLToPath(new URL('./authenticated-links.overlay.yml', import.meta.url)),
        fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
      ],
      extraInstallAnchors: [fileURLToPath(new URL('../../../packages/bundle/gs-app/package.json', import.meta.url))],
    })
    await seedSession(scaffold, await readFile(join(SNAPSHOT_DIR, 'session.v3.jsonl'), 'utf8'), 'authenticated-links')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.route('**/api/gs-server/link-preview?**', async (route) => {
      expect(route.request().headers().authorization).toBeUndefined()
      expect(new URL(route.request().url()).searchParams.get('url'))
        .toBe('https://gs.example.test/gsclaw/api/v1/zhidu/files/1234567890123456789')
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? {
        fileName: 'Travel policy', content: CONTENT, truncated,
      } : status === 409 ? { code: 'source_endpoint_mismatch' } : { error: 'expired' }) })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByRole('link', { name: 'Travel policy', exact: true }).waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('formats sources, quotes selected passages with a source link, and reports read failures', async () => {
    const beforeUrl = page.url()
    await page.getByRole('link', { name: 'Travel policy', exact: true }).click()
    const reader = page.locator('[data-link-preview]')
    await reader.getByRole('heading', { name: 'Travel policy', exact: true }).waitFor()
    await reader.getByRole('heading', { name: 'Travel expense policy', exact: true }).waitFor()
    expect(await reader.getByRole('table').textContent()).toContain('Standard fare')
    expect(await reader.locator('blockquote').textContent()).toContain('Employees must retain receipts.')
    expect(await reader.getByRole('link', { name: 'the original policy' }).getAttribute('href'))
      .toBe('https://gs.example.test/gsclaw/api/v1/zhidu/files/1234567890123456789')
    expect(await reader.locator('script').count()).toBe(0)
    await reader.getByRole('button', { name: 'View raw text', exact: true }).click()
    expect(await reader.locator('pre').textContent()).toBe(CONTENT)
    await reader.getByRole('button', { name: 'View formatted text', exact: true }).click()
    expect(page.url()).toBe(beforeUrl)
    expect(page.context().pages()).toHaveLength(1)
    const original = await reader.ariaSnapshot()
    await mkdir(join(process.cwd(), '.artifacts'), { recursive: true })
    await page.screenshot({ path: join(process.cwd(), '.artifacts/authenticated-links.png') })
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(true)
    await page.screenshot({ path: join(process.cwd(), '.artifacts/authenticated-links-dark.png') })
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(false)
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.fill('Explain this policy. ')
    await reader.locator('blockquote').evaluate((element) => {
      const selection = element.ownerDocument.getSelection()!
      const range = element.ownerDocument.createRange()
      range.selectNodeContents(element)
      selection.removeAllRanges()
      selection.addRange(range)
      element.ownerDocument.dispatchEvent(new Event('selectionchange'))
    })
    await reader.getByRole('button', { name: 'Quote selection', exact: true }).click()
    await page.getByRole('alert').getByText('Quote added to the message draft', { exact: true }).waitFor()
    expect(await composer.innerText()).toContain('Explain this policy.')
    expect(await composer.innerText()).toContain('> Employees must retain receipts.')
    expect(await composer.innerText()).toContain('[Travel policy](<https://gs.example.test/gsclaw/api/v1/zhidu/files/1234567890123456789>)')
    truncated = true
    await reader.getByRole('button', { name: 'Reload', exact: true }).click()
    await reader.getByText('The displayed content is incomplete', { exact: true }).waitFor()
    const incomplete = await reader.ariaSnapshot()
    status = 409
    await reader.getByRole('button', { name: 'Reload', exact: true }).click()
    await reader.getByText('The source link does not match your signed-in service. Ask an administrator to update the policy links.', { exact: true }).waitFor()
    const mismatch = await reader.ariaSnapshot()
    status = 401
    await reader.getByRole('button', { name: 'Reload', exact: true }).click()
    await reader.getByText('Your sign-in expired. Sign in again and retry.', { exact: true }).waitFor()
    const expired = await reader.ariaSnapshot()
    await mkdir(dirname(EXPECTED), { recursive: true })
    await compareOrRefreshGolden(EXPECTED, `# Original\n\n${original}\n\n# Incomplete\n\n${incomplete}\n\n# Source address mismatch\n\n${mismatch}\n\n# Expired sign-in\n\n${expired}\n`, MODE)
  })
})
