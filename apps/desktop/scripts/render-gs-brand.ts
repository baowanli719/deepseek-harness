/**
 * Render the gs-worker (国盛办公AI) brand icons and installer artwork from
 * `brand/gs/source-mark.png`.
 *
 * The source mark is a read-only copy of the product cloud logo (the legacy
 * desktop product's `build/app-icon.png`); update it by copying a newer export
 * over it, never by editing the source directory. The committed outputs are the
 * transparent Windows application PNG/ICO, the macOS application tile,
 * the multi-size Windows tray icon, and the NSIS installer artwork
 * under `installer/` (welcome/progress brand art in light and dark, and the
 * uninstaller sidebar). Rerun `pnpm run render:gs-brand` in `apps/desktop` after
 * replacing the source mark.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'
import { packIco, TRAY_ICON_SIZES } from './render-tray-icon.ts'

/** Brand directory holding the source mark and the generated icons. */
export const GS_BRAND_DIR = fileURLToPath(new URL('../brand/gs/', import.meta.url))

/** Installer artwork output directory inside the brand directory. */
export const GS_BRAND_INSTALLER_DIR = fileURLToPath(new URL('../brand/gs/installer/', import.meta.url))

/** Edge length of the packaged application icons. */
export const APP_ICON_EDGE = 1024

/** Corner radius of the white application tile, matching platform icon conventions. */
const TILE_RADIUS = 180

/** Share of the tile edge the mark occupies; the cloud keeps its own internal padding. */
const TILE_MARK_RATIO = 0.78

/** Share of a tray bitmap edge the mark occupies. */
const TRAY_MARK_RATIO = 1.0

const TILE_BACKGROUND = '#ffffff'

/** Installer brand art geometry: the upstream pair is 600x196 with a 1x/2x twin. */
const BRAND_ART = { width: 600, height: 196, markEdge: 104, textY: 166, fontSize: 34 } as const

/** Uninstaller sidebar geometry and colors, mirroring the upstream asset. */
const SIDEBAR = {
  width: 164, height: 314, tileEdge: 108, tileRadius: 18, markEdge: 76,
  background: '#f4f6f8', tile: '#ffffff',
} as const

/**
 * Compose the Windows application icon with the source mark's transparency.
 * @param mark - Source mark bitmap.
 * @param edge - Output edge length.
 * @returns PNG bytes of the square application icon.
 */
export async function renderGsAppIcon(mark: Buffer, edge: number = APP_ICON_EDGE): Promise<Buffer> {
  const markEdge = Math.round(edge * TILE_MARK_RATIO)
  const resized = await sharp(mark).resize(markEdge, markEdge, { fit: 'inside' }).png().toBuffer()
  return sharp({
    create: { width: edge, height: edge, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{ input: resized, gravity: 'center' }]).png().toBuffer()
}

/** Compose the macOS application tile with its existing white rounded background. */
async function renderGsMacAppIcon(mark: Buffer): Promise<Buffer> {
  const edge = APP_ICON_EDGE
  const tile = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(edge)}" height="${String(edge)}">`
    + `<rect width="${String(edge)}" height="${String(edge)}" rx="${String(TILE_RADIUS)}" fill="${TILE_BACKGROUND}"/>`
    + '</svg>',
  )
  return sharp(tile).composite([{ input: await renderGsAppIcon(mark), gravity: 'center' }]).png().toBuffer()
}

/**
 * Render the mark at every tray size and pack the bitmaps into one ICO file.
 * @param mark - Source mark bitmap.
 * @returns ICO bytes with one entry per {@link TRAY_ICON_SIZES} edge.
 */
export async function renderGsTrayIcon(mark: Buffer): Promise<Buffer> {
  const entries = await Promise.all(TRAY_ICON_SIZES.map(async (size) => {
    const markEdge = Math.round(size * TRAY_MARK_RATIO)
    const resized = await sharp(mark).resize(markEdge, markEdge, { fit: 'inside' }).png().toBuffer()
    const png = await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).composite([{ input: resized, gravity: 'center' }]).png().toBuffer()
    return { size, png }
  }))
  return packIco(entries)
}

/**
 * Compose the installer welcome/progress brand art: the cloud mark over the product name.
 * @param mark - Source mark bitmap.
 * @param scale - 1 for the base bitmap, 2 for the high-DPI twin.
 * @param textColor - Wordmark color for the light or dark installer theme.
 * @returns PNG bytes at `scale` times the base geometry.
 */
export async function renderGsInstallerBrand(mark: Buffer, scale: 1 | 2, textColor: string): Promise<Buffer> {
  const width = BRAND_ART.width * scale
  const height = BRAND_ART.height * scale
  const markEdge = BRAND_ART.markEdge * scale
  const resized = await sharp(mark).resize(markEdge, markEdge, { fit: 'inside' }).png().toBuffer()
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}">`
    + `<text x="${String(width / 2)}" y="${String(BRAND_ART.textY * scale)}" text-anchor="middle" `
    + `font-family="Segoe UI" font-size="${String(BRAND_ART.fontSize * scale)}" font-weight="600" `
    + `fill="${textColor}">gs-worker</text></svg>`,
  )
  return sharp(svg)
    .composite([{ input: resized, left: Math.round((width - markEdge) / 2), top: 8 * scale }])
    .png()
    .toBuffer()
}

/**
 * Compose the uninstaller sidebar: a light panel with the white tile carrying the mark.
 * @param mark - Source mark bitmap.
 * @returns PNG bytes at the stock NSIS sidebar size.
 */
export async function renderGsUninstallerSidebar(mark: Buffer): Promise<Buffer> {
  const tileLeft = Math.round((SIDEBAR.width - SIDEBAR.tileEdge) / 2)
  const tileTop = 96
  const tile = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(SIDEBAR.width)}" height="${String(SIDEBAR.height)}">`
    + `<rect width="${String(SIDEBAR.width)}" height="${String(SIDEBAR.height)}" fill="${SIDEBAR.background}"/>`
    + `<rect x="${String(tileLeft)}" y="${String(tileTop)}" width="${String(SIDEBAR.tileEdge)}" `
    + `height="${String(SIDEBAR.tileEdge)}" rx="${String(SIDEBAR.tileRadius)}" fill="${SIDEBAR.tile}"/>`
    + '</svg>',
  )
  const resized = await sharp(mark).resize(SIDEBAR.markEdge, SIDEBAR.markEdge, { fit: 'inside' }).png().toBuffer()
  const markOffset = Math.round((SIDEBAR.tileEdge - SIDEBAR.markEdge) / 2)
  return sharp(tile)
    .composite([{ input: resized, left: tileLeft + markOffset, top: tileTop + markOffset }])
    .png()
    .toBuffer()
}

async function main(): Promise<void> {
  const mark = await readFile(resolve(GS_BRAND_DIR, 'source-mark.png'))
  const icon = await renderGsAppIcon(mark)
  await writeFile(resolve(GS_BRAND_DIR, 'icon-windows.png'), icon)
  const entries = await Promise.all([16, 24, 32, 48, 64, 128, 256].map(async size => ({
    size, png: await renderGsAppIcon(mark, size),
  })))
  await writeFile(resolve(GS_BRAND_DIR, 'icon-windows.ico'), packIco(entries))
  await writeFile(resolve(GS_BRAND_DIR, 'icon-macos.png'), await renderGsMacAppIcon(mark))
  await writeFile(resolve(GS_BRAND_DIR, 'tray-windows.ico'), await renderGsTrayIcon(mark))
  const { mkdir } = await import('node:fs/promises')
  await mkdir(GS_BRAND_INSTALLER_DIR, { recursive: true })
  await writeFile(resolve(GS_BRAND_INSTALLER_DIR, 'brand.png'), await renderGsInstallerBrand(mark, 1, '#15171a'))
  await writeFile(resolve(GS_BRAND_INSTALLER_DIR, 'brand-2x.png'), await renderGsInstallerBrand(mark, 2, '#15171a'))
  await writeFile(resolve(GS_BRAND_INSTALLER_DIR, 'brand-dark.png'), await renderGsInstallerBrand(mark, 1, '#f9fafb'))
  await writeFile(resolve(GS_BRAND_INSTALLER_DIR, 'brand-dark-2x.png'), await renderGsInstallerBrand(mark, 2, '#f9fafb'))
  await writeFile(resolve(GS_BRAND_INSTALLER_DIR, 'uninstaller-sidebar.png'), await renderGsUninstallerSidebar(mark))
  console.info(`gs brand: wrote app icons, tray icon, and installer artwork under ${GS_BRAND_DIR}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
