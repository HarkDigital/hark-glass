import * as THREE from 'three'

/*
 * Canvas text for the Vitrine: the etched plaques on the display blocks and
 * the names on the nine index cards. Our own helper (not kit etch()) so the
 * glyphs are redrawn once Geist / Geist Mono have actually loaded, and so a
 * plate can mix a mono number with a sans name.
 */

export const SANS = "'Geist Variable', 'Geist', system-ui, sans-serif"
export const MONO = "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace"

let fontsPromise: Promise<void> | null = null

/** Resolves once both faces are loaded (or after 5s, whichever is first). */
export function fontsReady(): Promise<void> {
  if (fontsPromise) return fontsPromise
  const f = typeof document !== 'undefined' ? document.fonts : undefined
  if (!f || typeof f.load !== 'function') return (fontsPromise = Promise.resolve())
  fontsPromise = Promise.race([
    Promise.all([f.load(`500 48px ${MONO}`), f.load(`520 48px ${SANS}`)]).then(() => undefined),
    new Promise<void>(r => window.setTimeout(r, 5000)),
  ]).catch(() => undefined)
  return fontsPromise
}

/** Draw `text` with manual tracking (canvas letterSpacing is missing in Safari 15). Returns the drawn width. */
export function spaced(g: CanvasRenderingContext2D, text: string, x: number, y: number, tracking: number, measureOnly = false): number {
  if (!tracking) {
    const w = g.measureText(text).width
    if (!measureOnly) g.fillText(text, x, y)
    return w
  }
  let cx = x
  const chars = Array.from(text)
  chars.forEach((ch, i) => {
    if (!measureOnly) g.fillText(ch, cx, y)
    cx += g.measureText(ch).width + (i < chars.length - 1 ? tracking : 0)
  })
  return cx - x
}

export interface TextPlate {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  redraw(): void
}

/**
 * A transparent text plane `w` world units wide; `draw` paints white glyphs on
 * a `pw`×`ph` canvas. Sits just in front of a glass face (transparent objects
 * are drawn after glass, so anything behind the face would be hidden).
 */
export function textPlate(
  pw: number,
  ph: number,
  w: number,
  draw: (g: CanvasRenderingContext2D, pw: number, ph: number) => void,
  o: { opacity?: number; color?: THREE.ColorRepresentation } = {},
): TextPlate {
  const cv = document.createElement('canvas')
  cv.width = pw
  cv.height = ph
  const g = cv.getContext('2d')!
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  const paint = () => {
    g.clearRect(0, 0, pw, ph)
    g.fillStyle = '#ffffff'
    g.textBaseline = 'middle'
    draw(g, pw, ph)
    tex.needsUpdate = true
  }
  paint()
  fontsReady().then(paint)
  const material = new THREE.MeshBasicMaterial({
    map: tex,
    color: new THREE.Color(o.color ?? '#ffffff'),
    transparent: true,
    opacity: o.opacity ?? 0.8,
    depthWrite: false,
    toneMapped: true,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, (w * ph) / pw), material)
  return { mesh, material, redraw: paint }
}
