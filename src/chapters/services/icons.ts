import { SERVICES } from '../../content'

/*
 * Facets — the eleven service glyphs, drawn as thin light lines into one
 * canvas atlas (one tall cell per facet). Each cell is what sits INSIDE a
 * glass tile: the facet number etched at the top and the icon as a glowing
 * line glyph. The chapter tints and brightens each
 * cell per frame (additive, HDR), and the glass refracts it.
 *
 * Glyphs are designed in a 100 x 100 box centred on 0,0 (y down), stroke only,
 * round joins and caps: one line weight, one visual language.
 */

type Ctx = CanvasRenderingContext2D
type Pt = [number, number]

function poly(g: Ctx, pts: Pt[], close = false) {
  g.beginPath()
  g.moveTo(pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1])
  if (close) g.closePath()
  g.stroke()
}

function circle(g: Ctx, x: number, y: number, r: number, fill = false) {
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  if (fill) g.fill()
  else g.stroke()
}

function rrectPath(g: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  g.beginPath()
  g.moveTo(x + rr, y)
  g.arcTo(x + w, y, x + w, y + h, rr)
  g.arcTo(x + w, y + h, x, y + h, rr)
  g.arcTo(x, y + h, x, y, rr)
  g.arcTo(x, y, x + w, y, rr)
  g.closePath()
}

function rrect(g: Ctx, x: number, y: number, w: number, h: number, r: number) {
  rrectPath(g, x, y, w, h, r)
  g.stroke()
}

/** One glyph per service slug (fallback: the mark's diamond). */
const GLYPHS: Record<string, (g: Ctx) => void> = {
  // </> — code
  'software-development': g => {
    poly(g, [[-20, -22], [-42, 0], [-20, 22]])
    poly(g, [[20, -22], [42, 0], [20, 22]])
    poly(g, [[9, -32], [-9, 32]])
  },
  // a browser window with a layout grid
  'web-design': g => {
    rrect(g, -44, -34, 88, 68, 7)
    poly(g, [[-44, -18], [44, -18]])
    circle(g, -35, -26, 1.6, true)
    circle(g, -28, -26, 1.6, true)
    circle(g, -21, -26, 1.6, true)
    poly(g, [[-12, -18], [-12, 34]])
    poly(g, [[-12, 8], [44, 8]])
  },
  // a cart
  ecommerce: g => {
    poly(g, [[-46, -30], [-34, -30], [-24, 14], [30, 14], [38, -18], [-29, -18]])
    circle(g, -16, 28, 5.5)
    circle(g, 23, 28, 5.5)
  },
  // a magnifier with a spark (search + generative answers)
  'seo-geo': g => {
    circle(g, -8, -8, 26)
    poly(g, [[11, 11], [38, 38]])
    // four-point spark inside the lens
    g.beginPath()
    g.moveTo(-8, -22)
    g.quadraticCurveTo(-6, -10, 6, -8)
    g.quadraticCurveTo(-6, -6, -8, 6)
    g.quadraticCurveTo(-10, -6, -22, -8)
    g.quadraticCurveTo(-10, -10, -8, -22)
    g.closePath()
    g.stroke()
  },
  // a lightning bolt
  'page-speed': g => {
    poly(
      g,
      [
        [8, -46],
        [-24, 6],
        [-2, 6],
        [-10, 46],
        [24, -8],
        [2, -8],
      ],
      true,
    )
  },
  // a chip
  'ai-consulting': g => {
    rrect(g, -26, -26, 52, 52, 7)
    rrect(g, -12, -12, 24, 24, 3)
    for (const o of [-13, 0, 13]) {
      poly(g, [[o, -26], [o, -38]])
      poly(g, [[o, 26], [o, 38]])
      poly(g, [[-26, o], [-38, o]])
      poly(g, [[26, o], [38, o]])
    }
  },
  // a quadcopter, top-down
  'aerial-media': g => {
    rrect(g, -9, -9, 18, 18, 5)
    for (const [sx, sy] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ] as Pt[]) {
      poly(g, [[sx * 8, sy * 8], [sx * 22, sy * 22]])
      circle(g, sx * 30, sy * 30, 13)
      circle(g, sx * 30, sy * 30, 1.8, true)
    }
  },
  // a med-cross: repair
  'hack-remediation': g => {
    const a = 11
    const b = 38
    poly(
      g,
      [
        [-a, -b],
        [a, -b],
        [a, -a],
        [b, -a],
        [b, a],
        [a, a],
        [a, b],
        [-a, b],
        [-a, a],
        [-b, a],
        [-b, -a],
        [-a, -a],
      ],
      true,
    )
  },
  // a shield with a check
  security: g => {
    g.beginPath()
    g.moveTo(0, -44)
    g.bezierCurveTo(14, -34, 26, -32, 38, -31)
    g.lineTo(38, 0)
    g.bezierCurveTo(38, 22, 20, 36, 0, 46)
    g.bezierCurveTo(-20, 36, -38, 22, -38, 0)
    g.lineTo(-38, -31)
    g.bezierCurveTo(-26, -32, -14, -34, 0, -44)
    g.closePath()
    g.stroke()
    poly(g, [[-14, 2], [-4, 13], [16, -11]])
  },
  // the accessibility figure
  'ada-accessibility': g => {
    circle(g, 0, 0, 44)
    circle(g, 0, -24, 5.5)
    poly(g, [[-24, -11], [0, -7], [24, -11]])
    poly(g, [[0, -7], [0, 10]])
    poly(g, [[-14, 33], [0, 10], [14, 33]])
  },
  // W in a ring
  wordpress: g => {
    circle(g, 0, 0, 44)
    poly(g, [[-29, -17], [-16, 23], [0, -9], [16, 23], [29, -17]])
  },
}

const diamond = (g: Ctx) =>
  poly(
    g,
    [
      [0, -34],
      [34, 0],
      [0, 34],
      [-34, 0],
    ],
    true,
  )

export interface Atlas {
  canvas: HTMLCanvasElement
  /** redraw (after web fonts load) */
  draw: () => void
  cellW: number
  cellH: number
}

/**
 * The atlas: N cells side by side, each `cellW` x `cellH` px. White on
 * transparent; brightness and tint come from the material. `weight` thickens
 * the lines (phones see the glyphs through a half-resolution transmission pass);
 * `halo` adds a soft canvas glow around each line (desktop: bloom does the rest).
 */
export function buildAtlas(cellW: number, cellH: number, weight = 1, halo = true): Atlas {
  const n = SERVICES.length
  const canvas = document.createElement('canvas')
  canvas.width = cellW * n
  canvas.height = cellH
  const g = canvas.getContext('2d')!
  const s = cellW / 256 // design scale (cells are designed at 256 px wide)

  const draw = () => {
    g.clearRect(0, 0, canvas.width, canvas.height)
    for (let i = 0; i < n; i++) {
      const svc = SERVICES[i]
      g.save()
      g.translate(i * cellW, 0)

      // facet number, etched at the top
      g.fillStyle = 'rgba(255,255,255,0.5)'
      g.font = `500 ${Math.round(30 * s)}px 'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace`
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillText(svc.num, cellW / 2, 58 * s)
      // a short hairline under it
      g.fillStyle = 'rgba(255,255,255,0.32)'
      g.fillRect(cellW / 2 - 14 * s, 84 * s, 28 * s, 2 * s)

      // the glyph: a soft halo pass, then the crisp line
      const gs = (cellW * 0.62) / 100 // glyph box ≈ 62% of the cell width
      g.translate(cellW / 2, cellH * 0.47)
      g.scale(gs, gs)
      g.lineJoin = 'round'
      g.lineCap = 'round'
      const glyph = GLYPHS[svc.slug] ?? diamond
      if (halo) {
        g.strokeStyle = 'rgba(255,255,255,0.35)'
        g.fillStyle = 'rgba(255,255,255,0.35)'
        g.lineWidth = ((7.5 * s) / gs) * 1.6 * weight
        g.shadowColor = 'rgba(255,255,255,0.9)'
        g.shadowBlur = 14 * s
        glyph(g)
        g.shadowBlur = 0
      }
      g.strokeStyle = '#ffffff'
      g.fillStyle = '#ffffff'
      g.lineWidth = ((7 * s) / gs) * weight
      glyph(g)
      g.restore()
    }
  }
  draw()
  return { canvas, draw, cellW, cellH }
}
