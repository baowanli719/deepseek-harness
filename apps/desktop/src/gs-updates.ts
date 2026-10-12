/** GS server release notices and confirmed downloads; gateway credentials stay in the Host. */
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { valid } from 'semver'
import type { GsAppUpdateConfig } from '@deepseek-ai/dsh-gs-server'
import type { DesktopReleaseSource } from './update-coordinator.ts'
import type { DesktopMessages } from './locale.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a server release notice before any URL or filename reaches the native updater.
 * @param value - Unvalidated appUpdate field from the authenticated ClientConfig pull.
 * @returns Parsed notice, null for no published release, or undefined for malformed input.
 */
export function parseGsDesktopRelease(value: unknown): GsAppUpdateConfig | null | undefined {
  if (value === null) return null
  if (!record(value) || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(value.version)
    || valid(value.version) !== value.version || !record(value.downloads)) return undefined
  const downloads: { windowsX64?: string; macArm?: string; macIntel?: string } = {}
  for (const key of ['windowsX64', 'macArm', 'macIntel'] as const) {
    const candidate = value.downloads[key]
    if (candidate === undefined) continue
    if (typeof candidate !== 'string') return undefined
    let url: URL
    try { url = new URL(candidate) } catch { return undefined }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return undefined
    downloads[key] = candidate
  }
  if (!Object.keys(downloads).length) return undefined
  if (value.notes !== undefined && (!Array.isArray(value.notes) || value.notes.some(note => typeof note !== 'string'))) return undefined
  const notes = Array.isArray(value.notes) ? value.notes.filter((note): note is string => typeof note === 'string') : undefined
  if (value.availableFrom !== undefined && (typeof value.availableFrom !== 'string' || !Number.isFinite(Date.parse(value.availableFrom)))) return undefined
  const window = value.downloadWindow
  if (window !== undefined && window !== null && (!record(window) || typeof window.start !== 'string' || typeof window.end !== 'string'
    || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(window.start) || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(window.end))) return undefined
  return { version: value.version, downloads, ...(notes === undefined ? {} : { notes }),
    ...(window === undefined || window === null ? {} : { downloadWindow: { start: String(window.start), end: String(window.end) } }),
    ...(typeof value.availableFrom === 'string' ? { availableFrom: value.availableFrom } : {}) }
}

/** Native updater inputs; only the server-selected release URL is eligible for a download. */
export interface GsDesktopReleaseOptions {
  /** Private authenticated Host pull, returning only the appUpdate notice. */
  pull(signal: AbortSignal): Promise<unknown>
  /** Credential-free request used for the direct installer link. */
  request(url: string, init: RequestInit): Promise<Response>
  /** Private update artifact directory below application userData. */
  directory: string
  /** Current platform and CPU architecture. */
  platform: string
  arch: string
  /** Launch a completely written installer after the shell stops active tasks. */
  install(path: string): Promise<void>
  /** Verify OS trust and the installed application's signing identity; failure refuses installation. */
  verify(path: string): Promise<void>
  /** Selected native dictionary, resolved again after a locale change. */
  messages(): DesktopMessages
}

/** GS release source sharing the shell's version confirmation, task lock, and download status. */
export class GsDesktopReleaseSource implements DesktopReleaseSource {
  private readonly abort = new AbortController()
  private checked: { notice: GsAppUpdateConfig; url: string } | undefined
  private prepared: { version: string; path: string } | undefined

  constructor(private readonly options: GsDesktopReleaseOptions) {}

  /** Last validated release; notes and availability apply only to this checked version. */
  get notice(): GsAppUpdateConfig | undefined { return this.checked?.notice }

  /**
   * Pull the current user's server config; signed-out, offline, and malformed responses fail visibly.
   * @returns The applicable platform release version, or undefined when none is published.
   */
  async check(): Promise<string | undefined> {
    const value = await this.options.pull(AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]))
    this.abort.signal.throwIfAborted()
    if (!record(value)) throw new Error(this.options.messages().gsUpdateInvalid)
    const notice = parseGsDesktopRelease(value.appUpdate)
    if (notice === undefined) throw new Error(this.options.messages().gsUpdateInvalid)
    const url = notice === null ? undefined : this.options.platform === 'win32' ? notice.downloads.windowsX64
      : this.options.platform === 'darwin' ? this.options.arch === 'arm64' ? notice.downloads.macArm
        : this.options.arch === 'x64' ? notice.downloads.macIntel : undefined : undefined
    this.checked = notice !== null && url !== undefined ? { notice, url } : undefined
    return this.checked?.notice.version
  }

  /**
   * Download the exact confirmed notice into a new private file and validate its native format.
   * @param version - Version confirmed in the native dialog.
   * @param progress - Bounded percentage updates; 100 is emitted only after file validation.
   */
  async download(version: string, progress: (percent: number) => void): Promise<void> {
    const checked = this.checked
    if (checked === undefined || checked.notice.version !== version) throw new Error(this.options.messages().gsUpdateStale)
    if (checked.notice.availableFrom !== undefined && Date.now() < Date.parse(checked.notice.availableFrom)) {
      throw new Error(this.options.messages().gsUpdateNotAvailable)
    }
    const window = checked.notice.downloadWindow
    if (window !== undefined && window !== null) {
      const now = new Date()
      const current = now.getHours() * 60 + now.getMinutes()
      const minutes = (value: string): number => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
      const start = minutes(window.start)
      const end = minutes(window.end)
      const allowed = start === end || (start < end ? current >= start && current < end : current >= start || current < end)
      if (!allowed) throw new Error(this.options.messages().gsUpdateNotAvailable)
    }
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(30 * 60_000)])
    const response = await this.options.request(checked.url, { method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal })
    if (!response.ok || response.body === null) throw new Error(this.options.messages().gsUpdateDownloadFailed)
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    const extension = this.options.platform === 'win32' ? '.exe' : '.dmg'
    const target = join(this.options.directory, `gs-worker-${version}-${randomUUID()}${extension}`)
    const partial = target + '.part'
    const file = await open(partial, 'wx+', 0o600)
    const reader = response.body.getReader()
    const total = Number(response.headers.get('content-length'))
    let received = 0
    try {
      try {
        for (;;) {
          signal.throwIfAborted()
          const chunk = await reader.read()
          if (chunk.done) break
          received += chunk.value.byteLength
          if (received > 2 * 1024 ** 3) throw new Error(this.options.messages().gsUpdateDownloadFailed)
          await file.writeFile(chunk.value)
          if (total > 0 && Number.isFinite(total)) progress(Math.min(98, received * 100 / total))
        }
        if (!received || (total > 0 && total !== received)) throw new Error(this.options.messages().gsUpdateDownloadFailed)
        if (extension === '.exe') {
          const dos = Buffer.alloc(64)
          await file.read(dos, 0, 64, 0)
          const offset = dos.readUInt32LE(60)
          if (dos.toString('ascii', 0, 2) !== 'MZ' || offset < 64 || offset > received - 4) throw new Error(this.options.messages().gsUpdateDownloadFailed)
          const pe = Buffer.alloc(4)
          await file.read(pe, 0, 4, offset)
          if (!pe.equals(Buffer.from([0x50, 0x45, 0, 0]))) throw new Error(this.options.messages().gsUpdateDownloadFailed)
        } else {
          const trailer = Buffer.alloc(4)
          if (received < 512) throw new Error(this.options.messages().gsUpdateDownloadFailed)
          await file.read(trailer, 0, 4, received - 512)
          if (trailer.toString('ascii') !== 'koly') throw new Error(this.options.messages().gsUpdateDownloadFailed)
        }
        await file.sync()
      } finally {
        await file.close()
        // A failed transport can already have closed the response reader.
        await reader.cancel().catch((_cause: unknown) => {})
      }
      signal.throwIfAborted()
      await rename(partial, target)
      await this.options.verify(target)
      this.prepared = { version, path: target }
      progress(100)
    } catch (cause) {
      await rm(partial, { force: true })
      await rm(target, { force: true })
      throw cause
    }
  }

  /**
   * Hand off only a completely validated artifact matching the confirmed version.
   * @param version - Version confirmed after download and task inspection.
   */
  async install(version: string): Promise<void> {
    this.abort.signal.throwIfAborted()
    if (this.prepared?.version !== version) throw new Error(this.options.messages().gsUpdateStale)
    await this.options.verify(this.prepared.path)
    this.abort.signal.throwIfAborted()
    await this.options.install(this.prepared.path)
  }

  /** Cancel network work and reject later download or installer handoffs. */
  dispose(): void { this.abort.abort() }
}
