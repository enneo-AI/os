import { execSync } from 'node:child_process'
import puppeteer from 'puppeteer-core'

// ============================================================ HTML → PDF (Chromium)
// Rendert die Brand-Templates aus enneo-brand.js pixelgenau als PDF.
// Chromium kommt aus Nix (nixpacks.toml); Browser wird pro Prozess einmal
// gestartet und wiederverwendet (Launch dauert ~1s, Container ist klein).

let browserPromise = null

// Für /health: welches Chromium würde genutzt (oder Fehlertext)
export function chromiumInfo() {
  try {
    return chromiumPath()
  } catch (err) {
    return err.message
  }
}

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH
  try {
    // Nixpacks legt Pakete in den Nix-Store, aber nicht immer in den PATH des
    // Runtime-Containers — deshalb zusätzlich direkt im Store globben.
    // "; true" am Ende: der Exit-Code der Suchkette darf execSync nicht werfen lassen —
    // entscheidend ist nur, ob stdout einen Pfad enthält.
    const out = execSync(
      'which chromium chromium-browser 2>/dev/null; ls -d /nix/store/*chromium*/bin/chromium /root/.nix-profile/bin/chromium 2>/dev/null; true',
      { encoding: 'utf8', shell: '/bin/bash' }
    )
      .trim()
      .split('\n')
      .filter(Boolean)
    if (!out.length) throw new Error('leer')
    return out[0]
  } catch {
    throw new Error('Chromium nicht gefunden — PDF-Erzeugung nicht verfügbar')
  }
}

async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        executablePath: chromiumPath(),
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--font-render-hinting=none'],
      })
      .catch((err) => {
        browserPromise = null
        throw err
      })
  }
  return browserPromise
}

/**
 * kind 'document'     → A4 hoch, Druck-Hintergründe an
 * kind 'presentation' → 16:9-Folien (PowerPoint-Maß 13.333×7.5in), 1 Folie = 1 Seite
 */
export async function htmlToPdf(html, kind) {
  const browser = await getBrowser()
  const page = await browser.newPage()
  try {
    await page.setViewport(
      kind === 'presentation' ? { width: 1280, height: 720 } : { width: 900, height: 1200 }
    )
    // networkidle0: wartet auf Google Fonts (Geist/Inter) — sonst Fallback-Font im PDF
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 45000 })
    if (kind === 'presentation') {
      // Screen-CSS arbeitet mit 100vh-Scroll-Snap — für den Druck: 1 Folie = 1 fixe Seite
      await page.addStyleTag({
        content:
          '.deck{overflow:visible!important;height:auto!important}' +
          '.slide{height:7.5in!important;page-break-after:always!important;break-after:page!important}' +
          '.slide:last-child{page-break-after:auto!important}',
      })
      return await page.pdf({
        width: '13.333in',
        height: '7.5in',
        printBackground: true,
        margin: { top: 0, bottom: 0, left: 0, right: 0 },
      })
    }
    return await page.pdf({ format: 'A4', printBackground: true })
  } finally {
    await page.close().catch(() => {})
  }
}
