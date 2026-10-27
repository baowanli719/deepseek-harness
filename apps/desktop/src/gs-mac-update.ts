/** Stage a verified GS disk image for electron-updater's signed macOS installation and relaunch. */
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import electronUpdater from 'electron-updater'

const execute = promisify(execFile)
interface BundleIdentity { identifier: string; version: string; executable: string }
interface MacOperations {
  mount(artifact: string, mount: string): Promise<void>
  unmount(mount: string): Promise<void>
  identity(bundle: string): Promise<BundleIdentity>
  archive(bundle: string, zip: string, arch: string, signal: AbortSignal): Promise<void>
}
interface MacUpdater {
  updateConfigPath: string | null
  disableDifferentialDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
async function command(file: string, args: string[], signal?: AbortSignal) {
  return execute(file, args, { encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024, signal,
    env: Object.fromEntries(Object.entries(process.env)
      .filter(([name]) => !/key|secret|token|password|^NODE_OPTIONS$|^NODE_PATH$|^ELECTRON_RUN_AS_NODE$/iu.test(name))) })
}
async function plist(commandFile: string, args: string[]): Promise<unknown> {
  const { stdout } = await command(commandFile, args)
  const conversion = execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { encoding: 'utf8', timeout: 30_000 })
  conversion.child.stdin?.end(stdout)
  const result: unknown = JSON.parse((await conversion).stdout)
  return result
}

const nativeOperations: MacOperations = {
  async mount(artifact, mount) {
    await command('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, artifact])
  },
  async unmount(mount) {
    // An interrupted attach can leave a volume mounted even when its command failed.
    const value = await plist('/usr/bin/hdiutil', ['info', '-plist'])
    if (!record(value) || !Array.isArray(value.images)) throw new Error('GS update: could not inspect mounted images')
    for (const image of value.images) {
      if (!record(image) || !Array.isArray(image['system-entities'])) throw new Error('GS update: invalid disk-image information')
      if (image['system-entities'].some(entity => record(entity) && entity['mount-point'] === mount)) {
        await command('/usr/bin/hdiutil', ['detach', mount])
        return
      }
    }
  },
  async identity(bundle) {
    const { stdout } = await command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Info.plist')])
    const value: unknown = JSON.parse(stdout)
    if (!record(value) || typeof value.CFBundleIdentifier !== 'string' || typeof value.CFBundleShortVersionString !== 'string'
      || typeof value.CFBundleExecutable !== 'string' || basename(value.CFBundleExecutable) !== value.CFBundleExecutable
      || ['.', '..', ''].includes(value.CFBundleExecutable)) throw new Error('GS update: invalid application identity')
    return { identifier: value.CFBundleIdentifier, version: value.CFBundleShortVersionString, executable: value.CFBundleExecutable }
  },
  async archive(bundle, zip, arch, signal) {
    const identity = await nativeOperations.identity(bundle)
    await command('/usr/bin/lipo', ['-verify_arch', arch === 'arm64' ? 'arm64' : 'x86_64',
      join(bundle, 'Contents', 'MacOS', identity.executable)], signal)
    await command('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip], signal)
  },
}

/** Preparation is reversible; cleanup failure retains the private stage for diagnosis. */
export class GsMacUpdateError extends Error {
  /**
   * @param kind - Failed operation.
   * @param cause - Original failure, including cleanup failures.
   */
  constructor(readonly kind: 'prepare' | 'cleanup' | 'not-ready', cause?: unknown) {
    super(`GS macOS update failed (${kind})`, { cause })
  }
}

/** Native application identity and private download storage supplied by the shell. */
export interface GsMacUpdateOptions {
  /** Installed .app whose bundle identifier must match the update. */
  installedBundle: string
  /** Private update directory, outside the installation. */
  directory: string
  /** Installed CPU architecture. */
  arch: 'arm64' | 'x64'
  /** OS signature and publisher verification of the extracted application. */
  verifyBundle(path: string): Promise<void>
}

/** Owns the temporary feed; electron-updater owns the validated ZIP and native installation transaction. */
export class GsMacUpdateInstaller {
  private readonly abort = new AbortController()
  private operation: Promise<void> | undefined
  private server: Server | undefined
  private prepared = false

  /**
   * @param options - Installed identity, private staging, and OS verification.
   * @param updater - Process-owned updater, shared with the coordinator.
   * @param operations - Native commands, replaceable at the OS test boundary.
   */
  constructor(private readonly options: GsMacUpdateOptions,
    private readonly updater: MacUpdater = electronUpdater.autoUpdater,
    private readonly operations: MacOperations = nativeOperations) {}

  /**
   * Stage a verified disk image while the client remains open; this never authorizes installation.
   * @param artifact - Disk image already verified by the GS release source.
   * @param version - Server-selected version confirmed for download.
   * @returns Once electron-updater has verified and cached the ZIP; failure keeps the installed app unchanged.
   */
  async prepare(artifact: string, version: string): Promise<void> {
    this.abort.signal.throwIfAborted()
    if (this.operation !== undefined) throw new GsMacUpdateError('prepare')
    this.prepared = false
    const pending = this.stage(artifact, version)
    this.operation = pending
    try { await pending; this.prepared = true } finally { this.operation = undefined }
  }

  /** Install the prepared update after consent and task shutdown; native macOS quits only when it is ready to replace and relaunch. */
  install(): void {
    this.abort.signal.throwIfAborted()
    if (!this.prepared) throw new GsMacUpdateError('not-ready')
    this.updater.quitAndInstall()
  }

  /** Stop pending downloads and await native-command and mount cleanup before application shutdown. */
  async dispose(): Promise<void> {
    this.abort.abort()
    this.server?.closeAllConnections()
    try { await this.operation } catch (error) {
      // Preparation failures cannot change the installed app; incomplete mount cleanup must remain visible.
      if (error instanceof GsMacUpdateError && error.kind === 'cleanup') throw error
    }
  }

  private async stage(artifact: string, version: string): Promise<void> {
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 })
    const stage = await mkdtemp(join(this.options.directory, 'gs-mac-install-'))
    const mount = join(stage, 'volume')
    let failure: unknown
    try {
      await mkdir(mount)
      this.abort.signal.throwIfAborted()
      await this.operations.mount(artifact, mount)
      this.abort.signal.throwIfAborted()
      const bundle = join(mount, basename(this.options.installedBundle))
      const installed = await this.operations.identity(this.options.installedBundle)
      const incoming = await this.operations.identity(bundle)
      if (incoming.identifier !== installed.identifier || incoming.version !== version) throw new GsMacUpdateError('prepare')
      await this.options.verifyBundle(bundle)
      this.abort.signal.throwIfAborted()
      const name = `update-${this.options.arch}.zip`
      const zip = join(stage, name)
      await this.operations.archive(bundle, zip, this.options.arch, this.abort.signal)
      this.abort.signal.throwIfAborted()
      const hash = createHash('sha512')
      const bytes: AsyncIterable<Uint8Array> = createReadStream(zip)
      for await (const chunk of bytes) hash.update(chunk)
      const sha512 = hash.digest('base64')
      const size = (await stat(zip)).size
      const metadata = JSON.stringify({ version, path: name, sha512, files: [{ url: name, sha512, size }] })
      const key = randomUUID()
      const server = createServer((request, response) => {
        const path = (request.url ?? '/').split('?')[0]
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405); response.end(); return }
        if (path === `/${key}/nightly-mac.yml` || path === `/${key}/latest-mac.yml`) {
          response.writeHead(200, { 'content-type': 'application/yaml', 'content-length': Buffer.byteLength(metadata) })
          response.end(request.method === 'HEAD' ? undefined : metadata)
        } else if (path === `/${key}/${name}`) {
          response.writeHead(200, { 'content-type': 'application/zip', 'content-length': size })
          if (request.method === 'HEAD') { response.end(); return }
          const stream = createReadStream(zip)
          stream.on('error', error => response.destroy(error))
          response.on('close', () => { stream.destroy() })
          stream.pipe(response)
        } else { response.writeHead(404); response.end() }
      })
      this.server = server
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
      })
      const address = server.address()
      if (address === null || typeof address === 'string') throw new GsMacUpdateError('prepare')
      const config = join(stage, 'app-update.yml')
      await writeFile(config, JSON.stringify({ provider: 'generic', url: `http://127.0.0.1:${address.port}/${key}/`,
        updaterCacheDirName: 'gs-worker-updater' }), { mode: 0o600 })
      this.updater.updateConfigPath = config
      this.updater.disableDifferentialDownload = true
      this.updater.autoInstallOnAppQuit = false
      this.updater.autoRunAppAfterInstall = true
      this.abort.signal.throwIfAborted()
      const checked = await this.updater.checkForUpdates()
      if (checked?.updateInfo.version !== version || !checked.isUpdateAvailable) throw new GsMacUpdateError('prepare')
      await this.updater.downloadUpdate()
      this.abort.signal.throwIfAborted()
    } catch (error) {
      failure = error
      throw new GsMacUpdateError('prepare', error)
    } finally {
      const errors: unknown[] = failure === undefined ? [] : [failure]
      const server = this.server
      this.server = undefined
      try {
        if (server?.listening) {
          server.closeAllConnections()
          await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
        }
      } catch (error) { errors.push(error) }
      try {
        await this.operations.unmount(mount)
        await rm(stage, { recursive: true, force: true })
      } catch (error) { errors.push(error) }
      if (errors.length > (failure === undefined ? 0 : 1)) throw new GsMacUpdateError('cleanup', new AggregateError(errors))
    }
  }
}
