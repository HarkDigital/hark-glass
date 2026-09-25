import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, rng, segment, smoothstep, window01 } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECURITY, STATS } from '../../content'
import { G, GLASS, edgeGlow, glass, glassLogo, smoothExtrude, type GlassLogo } from '../../kit/glass'
import { buildCracks, type V2 } from './crack'
import { crackGeometry, crackMaterial, etchGeometry, etchMaterial, shapeOf, sheenMaterial, siteTexture } from './site'
import { curvedSlab } from './slab'
import './shield.css'

/*
 * TEMPERED — "Hacked? Breathe."
 *
 * "Your site" is a floating pane of clear glass with a minimal website etched
 * into it (browser frame, nav, hero, a dashboard card, three feature cards).
 * The Hark mark hovers at its shoulder, the guardian.
 *
 *   0.00–0.08  IN       calm: cool light, a slow light sweep across the pane,
 *                       a glass status card pinned to the site: "All clear".
 *   0.08–0.30  BREACH   the light turns ember; a fracture grows from an impact
 *                       point (spider → rays → ring → branches), hot at its
 *                       front; a little heat shimmer; the status card turns
 *                       "Intrusion detected". The camera leans in.
 *   0.30–0.60  BREATHE  a frost focus-pull, and the cracked pane parts into
 *                       seven slow glass shards (an exploded view in depth)
 *                       while the red drains out. 'Hacked? Breathe.' comes
 *                       into focus with the eyebrow and body (settled at the
 *                       0.45 landing).
 *   0.60–0.95  TEMPERED the shards glide back and re-seat, their seams light
 *                       signal green, then the light retracts along the
 *                       cracks into the impact point: the glass heals. A thick
 *                       curved shield of tempered glass slides in front of the
 *                       site on a light sweep; cool mint light; 24/7 + label +
 *                       the emergency CTA (anchor 0.8).
 *   0.95–1.00  OUT      still.
 *
 * Everything derives from `local`; frame.time only drives idle float.
 */

const W = 3.2
const H = 2.1
const RADIUS = 0.17
const DEPTH = 0.13
const BEVEL = 0.028
/** shards bevel thinner than the whole pane so the seams read as cracks, not leading */
const SHARD_BEVEL = 0.015
const FRONT = DEPTH / 2 + BEVEL
const IMPACT: V2 = [0.3, 0.2]
const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]

const T = {
  impact: 0.075,
  grown: 0.265,
  split: 0.282,
  /** shards part */
  part0: 0.286,
  part1: 0.5,
  /** shards glide back */
  seat0: 0.555,
  seat1: 0.66,
  /** seated: back to one pane, the green light retracts along the cracks */
  heal: 0.664,
  healed: 0.79,
  shield0: 0.7,
  shield1: 0.87,
}

/** long, settling ease-out (≈ cubic-bezier(0.16, 1, 0.3, 1)) */
const outQuart = (t: number) => 1 - Math.pow(1 - clamp(t), 4)

// ------------------------------------------------------------------ moods

interface Mood {
  a: THREE.Color
  b: THREE.Color
  c: THREE.Color
  d: THREE.Color
  base: THREE.Color
  strip: THREE.Color
  glow: number
  strips: number
  env: number
  /** etched site: neutral lines and accents (linear) */
  neutral: THREE.Color
  accent: THREE.Color
}

const lin = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b)
const mood = (
  a: string,
  b: string,
  c: string,
  d: string,
  base: string,
  strip: string,
  glow: number,
  strips: number,
  env: number,
  neutral: THREE.Color,
  accent: THREE.Color,
): Mood => ({
  a: new THREE.Color(a),
  b: new THREE.Color(b),
  c: new THREE.Color(c),
  d: new THREE.Color(d),
  base: new THREE.Color(base),
  strip: new THREE.Color(strip),
  glow,
  strips,
  env,
  neutral,
  accent,
})

const MOODS: Mood[] = [
  // IN: a cool, quiet studio
  mood(G.aqua, G.iris, '#12304a', '#3a1636', '#05070c', '#eafff5', 0.82, 0.85, 1.15, lin(0.5, 0.56, 0.6), new THREE.Color(G.signal).multiplyScalar(0.85)),
  // BREACH: ember behind the site, the rest of the room stays dark
  mood(G.ember, '#b8321c', '#3a0916', '#4a0f24', '#0b0607', '#ffcfc0', 0.9, 0.55, 1.0, lin(0.46, 0.36, 0.34), lin(1.0, 0.16, 0.1)),
  // BREATHE: deep iris, calm
  mood(G.iris, '#1d6a86', '#1b1450', '#35143c', '#05070c', '#e6eeff', 0.8, 0.7, 1.15, lin(0.46, 0.5, 0.6), lin(0.36, 0.3, 0.9)),
  // TEMPERED: signal and deep teal
  mood(G.signal, '#0e7a66', '#0f2c48', '#241e66', '#040809', '#eafff5', 0.78, 0.85, 1.3, lin(0.52, 0.6, 0.58), new THREE.Color(G.signal)),
]

function moodWeights(l: number, out: number[]) {
  const s1 = smoothstep(0.065, 0.16, l)
  const s2 = smoothstep(0.285, 0.42, l)
  const s3 = smoothstep(0.56, 0.7, l)
  out[0] = 1 - s1
  out[1] = s1 * (1 - s2)
  out[2] = s2 * (1 - s3)
  out[3] = s3
}

function mixC(out: THREE.Color, pick: (m: Mood) => THREE.Color, w: number[]) {
  out.setRGB(0, 0, 0)
  for (let i = 0; i < MOODS.length; i++) {
    if (w[i] <= 0) continue
    const c = pick(MOODS[i])
    out.r += c.r * w[i]
    out.g += c.g * w[i]
    out.b += c.b * w[i]
  }
  return out
}
const mixN = (pick: (m: Mood) => number, w: number[]) => MOODS.reduce((s, m, i) => s + pick(m) * w[i], 0)

// ------------------------------------------------------------------ camera

interface Layout {
  w: number
  h: number
  top: number
  bottom: number
  gutter: number
  aRight: number
  aTop: number
  bRight: number
  bTop: number
  ok: boolean
}
interface Region {
  cx: number
  cy: number
  fw: number
  fh: number
}
interface Key {
  l: number
  s: [number, number, number]
  sw: number
  sh: number
  yaw: number
  pitch: number
  /** 0 = whole safe area, 1 = beside/above copy A, 2 = beside/above copy B */
  reg: 0 | 1 | 2
  fill: number
}

const KEYS: Key[] = [
  { l: 0.0, s: [0.36, 0.08, 0.1], sw: 5.1, sh: 2.75, yaw: -0.22, pitch: 0.07, reg: 0, fill: 0.84 },
  { l: 0.075, s: [0.34, 0.08, 0.1], sw: 4.9, sh: 2.65, yaw: -0.17, pitch: 0.06, reg: 0, fill: 0.86 },
  { l: 0.28, s: [0.42, 0.12, 0.05], sw: 4.6, sh: 2.75, yaw: -0.08, pitch: 0.04, reg: 0, fill: 0.94 },
  { l: 0.42, s: [0.32, 0.06, 0.35], sw: 5.2, sh: 3.3, yaw: -0.4, pitch: 0.09, reg: 1, fill: 1.06 },
  { l: 0.555, s: [0.32, 0.06, 0.35], sw: 5.1, sh: 3.25, yaw: -0.46, pitch: 0.1, reg: 1, fill: 1.06 },
  { l: 0.8, s: [0.42, 0.1, 0.4], sw: 4.9, sh: 2.95, yaw: -0.24, pitch: 0.06, reg: 2, fill: 0.92 },
  { l: 1.0, s: [0.42, 0.1, 0.4], sw: 4.7, sh: 2.85, yaw: -0.17, pitch: 0.05, reg: 2, fill: 0.92 },
]

/** portrait: the mark rides above the pane's shoulder, so the pane can fill the width */
const KEYS_TALL: Key[] = [
  { l: 0.0, s: [0.02, 0.32, 0.1], sw: 3.75, sh: 3.3, yaw: -0.2, pitch: 0.07, reg: 0, fill: 0.9 },
  { l: 0.075, s: [0.02, 0.32, 0.1], sw: 3.7, sh: 3.2, yaw: -0.16, pitch: 0.06, reg: 0, fill: 0.92 },
  { l: 0.28, s: [0.1, 0.22, 0.05], sw: 3.5, sh: 2.95, yaw: -0.08, pitch: 0.04, reg: 0, fill: 0.96 },
  { l: 0.42, s: [0.06, 0.24, 0.35], sw: 4.9, sh: 3.9, yaw: -0.26, pitch: 0.08, reg: 1, fill: 1.0 },
  { l: 0.555, s: [0.06, 0.24, 0.35], sw: 4.8, sh: 3.85, yaw: -0.3, pitch: 0.09, reg: 1, fill: 1.0 },
  { l: 0.8, s: [0.02, 0.3, 0.4], sw: 3.95, sh: 3.35, yaw: -0.22, pitch: 0.06, reg: 2, fill: 0.95 },
  { l: 1.0, s: [0.02, 0.3, 0.4], sw: 3.85, sh: 3.25, yaw: -0.16, pitch: 0.05, reg: 2, fill: 0.95 },
]

/** studio turn keys: light sweeps run across the pane, the shards, the shield */
const TURN: [number, number][] = [
  [0.0, 0.35],
  [0.12, -0.05],
  [0.28, -0.12],
  [0.54, 0.55],
  [0.7, -0.75],
  [0.9, 0.42],
  [1.0, 0.5],
]
function envTurn(l: number) {
  for (let i = 0; i < TURN.length - 1; i++) {
    const [a, va] = TURN[i]
    const [b, vb] = TURN[i + 1]
    if (l <= b) return lerp(va, vb, ease.inOutCubic(segment(l, a, b)))
  }
  return TURN[TURN.length - 1][1]
}

function regionFor(kind: 0 | 1 | 2, L: Layout, out: Region) {
  const w = L.w
  const h = L.h
  const portrait = h > w * 1.05
  let x0 = L.gutter
  let x1 = w - L.gutter
  const y0 = L.top
  let y1 = h - L.bottom
  if (kind > 0 && L.ok) {
    if (portrait) y1 = Math.min(y1, (kind === 1 ? L.aTop : L.bTop) - 14)
    else x0 = Math.max(x0, (kind === 1 ? L.aRight : L.bRight) + 24)
  }
  if (y1 - y0 < h * 0.2) y1 = y0 + h * 0.2
  if (x1 - x0 < w * 0.3) x0 = x1 - w * 0.3
  out.cx = (x0 + x1) / w - 1
  out.cy = 1 - (y0 + y1) / h
  out.fw = (x1 - x0) / w
  out.fh = (y1 - y0) / h
}

const _ra: Region = { cx: 0, cy: 0, fw: 1, fh: 1 }
const _rb: Region = { cx: 0, cy: 0, fw: 1, fh: 1 }
const _r: Region = { cx: 0, cy: 0, fw: 1, fh: 1 }
const _dir = new THREE.Vector3()
const _fwd = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _Y = new THREE.Vector3(0, 1, 0)

/** Solve the camera for `l`; returns the region it framed (for the light field's focus). */
const isTall = (frame: Frame) => frame.height > frame.width * 1.05

function solvePose(l: number, frame: Frame, L: Layout, out: CameraPose): Region {
  const keys = isTall(frame) ? KEYS_TALL : KEYS
  let k = 0
  while (k < keys.length - 2 && l > keys[k + 1].l) k++
  const a = keys[k]
  const b = keys[k + 1]
  const t = ease.inOutCubic(segment(l, a.l, b.l))
  const lay = L.ok ? L : { ...L, w: frame.width, h: frame.height, top: 90, bottom: 90, gutter: 32 }
  regionFor(a.reg, lay, _ra)
  regionFor(b.reg, lay, _rb)
  _r.cx = lerp(_ra.cx, _rb.cx, t)
  _r.cy = lerp(_ra.cy, _rb.cy, t)
  _r.fw = lerp(_ra.fw, _rb.fw, t)
  _r.fh = lerp(_ra.fh, _rb.fh, t)
  const sx = lerp(a.s[0], b.s[0], t)
  const sy = lerp(a.s[1], b.s[1], t)
  const sz = lerp(a.s[2], b.s[2], t)
  const sw = lerp(a.sw, b.sw, t)
  const sh = lerp(a.sh, b.sh, t)
  const yaw = lerp(a.yaw, b.yaw, t)
  const pitch = lerp(a.pitch, b.pitch, t)
  const fill = lerp(a.fill, b.fill, t)
  const fov = isTall(frame) ? 34 : 30
  const aspect = frame.width / Math.max(1, frame.height)
  const tanV = Math.tan(THREE.MathUtils.degToRad(fov / 2))
  const tanX = tanV * aspect
  const D = Math.max(sw / (2 * tanX * _r.fw * fill), sh / (2 * tanV * _r.fh * fill))
  _dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch))
  _fwd.copy(_dir).negate()
  _right.crossVectors(_fwd, _Y).normalize()
  _up.crossVectors(_right, _fwd)
  out.position
    .set(sx, sy, sz)
    .addScaledVector(_dir, D)
    .addScaledVector(_right, -_r.cx * D * tanX)
    .addScaledVector(_up, -_r.cy * D * tanV)
  out.target.copy(out.position).addScaledVector(_fwd, D)
  out.fov = fov
  out.roll = 0
  out.parallax = 0.22
  return _r
}

// ------------------------------------------------------------------ chapter

interface ShardRig {
  root: THREE.Group
  glass: THREE.Mesh
  etch: THREE.Mesh
  sheen: THREE.Mesh
  lines: THREE.Mesh
  home: THREE.Vector3
  off: THREE.Vector3
  axis: THREE.Vector3
  tilt: number
  spin: number
  phase: number
}

export default function create(): Chapter {
  const group = new THREE.Group()
  const site = new THREE.Group()
  const shield = new THREE.Group()
  shield.visible = false
  group.add(site, shield)

  let intact: THREE.Mesh | null = null
  let intactEtch: THREE.Mesh | null = null
  let intactSheen: THREE.Mesh | null = null
  const shards: ShardRig[] = []
  let logo: GlassLogo | null = null
  let coreMat: THREE.MeshPhysicalMaterial | null = null
  let etchMat: THREE.ShaderMaterial | null = null
  let sheenMat: THREE.ShaderMaterial | null = null
  let crackMat: THREE.ShaderMaterial | null = null
  let rimMat: THREE.ShaderMaterial | null = null

  // DOM
  let status: Callout | null = null
  let copyA: HTMLElement
  let title: HTMLElement
  let copyB: HTMLElement
  let stat: HTMLElement
  let probe: HTMLElement
  let wasBreach = false

  const layout: Layout = { w: 1, h: 1, top: 90, bottom: 90, gutter: 32, aRight: 0, aTop: 0, bRight: 0, bTop: 0, ok: false }
  const wts = [1, 0, 0, 0]
  const colA = new THREE.Color()
  const colB = new THREE.Color()
  const colC = new THREE.Color()
  const colD = new THREE.Color()
  const colBase = new THREE.Color()
  const colStrip = new THREE.Color()
  const scratch: CameraPose = { position: new THREE.Vector3(), target: new THREE.Vector3(), fov: 30, roll: 0, parallax: 0 }
  const impactW = new THREE.Vector3()
  const q1 = new THREE.Quaternion()
  const q2 = new THREE.Quaternion()
  const Z = new THREE.Vector3(0, 0, 1)
  const EMBER = lin(1.0, 0.4, 0.26)
  const COOL = lin(0.62, 0.74, 0.95)
  const HEAL = new THREE.Color(G.signal)
  const HOT_BREACH = lin(1.0, 0.86, 0.72)
  const HOT_HEAL = lin(0.75, 1.0, 0.88)

  function measure(stage: HTMLElement) {
    const cs = getComputedStyle(probe)
    layout.w = stage.clientWidth || window.innerWidth
    layout.h = stage.clientHeight || window.innerHeight
    layout.top = parseFloat(cs.paddingTop) || 90
    layout.bottom = parseFloat(cs.paddingBottom) || 90
    layout.gutter = parseFloat(cs.paddingLeft) || 32
    layout.aRight = copyA.offsetLeft + copyA.offsetWidth
    layout.aTop = copyA.offsetTop
    layout.bRight = copyB.offsetLeft + copyB.offsetWidth
    layout.bTop = copyB.offsetTop
    layout.ok = layout.w > 0 && layout.h > 0 && copyA.offsetWidth > 0
  }

  return {
    id: 'shield',
    group,
    anchors: [0.8],

    async init(ctx: ChapterContext) {
      const stage = ctx.stage
      const mobile = ctx.mobile

      // ---------------- DOM (visual layer; the accessible copy is srContent)
      status = new Callout(stage, { side: 'right', offset: { x: 76, y: -58 } })
      status.root.classList.add('sh-status')
      const st = el('span', 'sh-st', undefined, status.label)
      el('span', 'sh-st-k sh-ok', 'All clear', st)
      el('span', 'sh-st-k sh-bad', 'Intrusion detected', st)
      el('span', 'sh-st-v', 'yoursite.com', status.label)

      copyA = el('div', 'sh-a', undefined, stage)
      el('p', 'hud-eyebrow sh-eyebrow', SECURITY.eyebrow, copyA)
      title = rise(el('h2', 'hud-title sh-title', undefined, copyA), 'Hacked?<br><em>Breathe.</em>')
      const panel = el('div', 'hud-panel hud-panel--strong sh-panel', undefined, copyA)
      el('p', 'hud-body', SECURITY.body, panel)

      copyB = el('div', 'sh-b', undefined, stage)
      stat = rise(el('p', 'hud-title sh-stat', undefined, copyB), `<em>${STAT.value}</em>`)
      el('p', 'hud-body sh-stat-label', STAT.label, copyB)
      const cta = el('a', 'hud-btn sh-cta', SECURITY.cta, copyB)
      cta.href = SECURITY.href

      probe = el('div', 'sh-probe', undefined, stage)
      reveal(copyA, 0)
      reveal(copyB, 0)
      measure(stage)
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => measure(stage))
        ro.observe(stage)
        ro.observe(copyA)
        ro.observe(copyB)
      } else window.addEventListener('resize', () => measure(stage))

      // ---------------- the site pane, and its fracture
      const cracks = buildCracks({ w: W, h: H, radius: RADIUS, impact: IMPACT, rays: mobile ? 5 : 6, seed: 7 })
      etchMat = etchMaterial(siteTexture(mobile))
      sheenMat = sheenMaterial()
      crackMat = crackMaterial()
      const paneMat = glass({ tint: '#e2fff2', tintDistance: 2.6, thickness: 0.32, ior: 1.5, dispersion: 0.35, env: 1.25, coat: 0.5 })

      intact = new THREE.Mesh(smoothExtrude(shapeOf(cracks.outline), { depth: DEPTH, bevel: BEVEL }), paneMat)
      const cap = etchGeometry(cracks.outline, W, H, 0, [0, 0])
      intactEtch = new THREE.Mesh(cap, etchMat)
      intactSheen = new THREE.Mesh(cap, sheenMat)
      intactSheen.position.z = FRONT + 0.002
      site.add(intact, intactEtch, intactSheen)
      await nextFrame()

      const R = rng(23)
      for (let i = 0; i < cracks.shards.length; i++) {
        const s = cracks.shards[i]
        const c = s.centroid
        const root = new THREE.Group()
        root.position.set(c[0], c[1], 0)
        const geo = smoothExtrude(shapeOf(s.poly), { depth: DEPTH + (BEVEL - SHARD_BEVEL) * 2, bevel: SHARD_BEVEL })
        geo.translate(-c[0], -c[1], 0)
        geo.computeBoundingSphere()
        const gm = new THREE.Mesh(geo, paneMat)
        const capGeo = etchGeometry(s.poly, W, H, 0, c)
        const em = new THREE.Mesh(capGeo, etchMat)
        const sm = new THREE.Mesh(capGeo, sheenMat)
        sm.position.z = FRONT + 0.002
        // phones refract at half resolution: slightly wider light lines survive it
        const lm = new THREE.Mesh(crackGeometry(s.lines, FRONT + 0.004, c, mobile ? 1.5 : 1), crackMat)
        gm.visible = em.visible = sm.visible = false
        root.add(gm, em, sm, lm)
        site.add(root)
        let off: THREE.Vector3
        let axis: THREE.Vector3
        let tilt: number
        let spin: number
        if (s.core) {
          off = new THREE.Vector3(-0.14, 0.08, 1.15)
          axis = new THREE.Vector3(0.7, -1, 0).normalize()
          tilt = 0.26
          spin = 0.12
        } else {
          const along = (c[0] + W / 2) / W
          const d = 0.36 + 0.2 * R()
          off = new THREE.Vector3(s.dir[0] * d, s.dir[1] * d * 0.9, lerp(0.8, -0.4, along) + (R() - 0.5) * 0.3)
          axis = new THREE.Vector3(-s.dir[1], s.dir[0], 0).normalize()
          tilt = 0.2 + 0.16 * R()
          spin = (R() - 0.5) * 0.2
        }
        shards.push({ root, glass: gm, etch: em, sheen: sm, lines: lm, home: root.position.clone(), off, axis, tilt, spin, phase: R() * Math.PI * 2 })
        if (i % 2 === 1) await nextFrame()
      }

      // ---------------- the guardian
      logo = glassLogo({ depth: 0.26 })
      coreMat = (logo.core.material as THREE.MeshPhysicalMaterial).clone()
      logo.core.material = coreMat
      logo.root.scale.setScalar(0.78)
      // no point light: its specular dot read as a stray LED on the pane
      logo.glow.intensity = 0
      group.add(logo.root)
      await nextFrame()

      // ---------------- the shield: tempered glass, curved
      const slab = curvedSlab(W + 0.46, H + 0.42, {
        radius: 0.3,
        depth: 0.16,
        bevel: 0.07,
        bendX: 4.4,
        bendY: 9,
        maxEdge: mobile ? 0.22 : 0.15,
        bevelSegments: mobile ? 4 : 7,
      })
      rimMat = edgeGlow(G.mint, 3, 0)
      shield.add(new THREE.Mesh(slab, GLASS.ice()), new THREE.Mesh(slab, rimMat))
    },

    update(l: number, frame: Frame, ctx: ChapterContext) {
      const rm = ctx.reducedMotion
      const t = frame.time * (rm ? 0.15 : 1)
      moodWeights(l, wts)

      // ---------------- light
      const wp = ctx.world.params
      wp.a = mixC(colA, m => m.a, wts)
      wp.b = mixC(colB, m => m.b, wts)
      wp.c = mixC(colC, m => m.c, wts)
      wp.d = mixC(colD, m => m.d, wts)
      wp.base = mixC(colBase, m => m.base, wts)
      wp.stripColor = mixC(colStrip, m => m.strip, wts)
      wp.glow = mixN(m => m.glow, wts)
      wp.strips = mixN(m => m.strips, wts)
      wp.env = mixN(m => m.env, wts)
      wp.flow = 1 - 0.4 * wts[2]
      const reg = solvePose(l, frame, layout, scratch)
      const aspect = frame.width / Math.max(1, frame.height)
      wp.focus.set(reg.cx * aspect, reg.cy)
      // pools and strips sized to the framed region: behind the subject, not across the copy
      wp.spread = clamp(Math.min(reg.fh * 1.45, reg.fw * 2 * aspect * 0.6), 0.45, 1.3)
      wp.envTurn = envTurn(l) * (rm ? 0.35 : 1)
      wp.keyDir.set(-0.55, 0.75, 0.6)
      wp.key = 1.7

      // ---------------- post
      const pp = ctx.post.params
      pp.glitch = rm ? 0 : 0.16 * window01(l, 0.1, 0.32, 0.07)
      pp.frost = (rm ? 0.08 : 0.15) * Math.min(smoothstep(0.268, 0.29, l), 1 - smoothstep(0.3, 0.36, l))
      const healGlow = window01(l, 0.58, 0.8, 0.06)
      pp.bloomStrength = 0.44 + 0.16 * wts[1] + 0.1 * healGlow
      pp.vignette = 0.28 + 0.08 * wts[1]

      // ---------------- the site: idle float
      site.position.set(0, 0.03 * Math.sin(t * 0.55), 0)
      site.rotation.set(0.018 * Math.sin(t * 0.33), 0.035 * Math.sin(t * 0.27), 0)
      if (etchMat) {
        mixC(etchMat.uniforms.uNeutral.value as THREE.Color, m => m.neutral, wts)
        mixC(etchMat.uniforms.uAccent.value as THREE.Color, m => m.accent, wts)
      }
      if (sheenMat) {
        // the streak rides the studio turn: every light sweep runs across the pane
        sheenMat.uniforms.uOff.value = 0.72 + wp.envTurn * 0.55
        sheenMat.uniforms.uStrength.value = 0.1 + 0.03 * wts[3]
        mixC(sheenMat.uniforms.uColor.value as THREE.Color, m => m.strip, wts)
      }

      // ---------------- shards: split, part, re-seat, heal
      const split = l >= T.split && l < T.heal
      if (intact) intact.visible = !split
      if (intactEtch) intactEtch.visible = !split
      if (intactSheen) intactSheen.visible = !split
      // part in slow motion (a long ease-out, then a slow drift), glide back
      const apart =
        (0.84 * outQuart(segment(l, T.part0, T.part1)) + 0.16 * segment(l, 0.42, T.seat0)) *
        (1 - ease.inOutCubic(segment(l, T.seat0, T.seat1)))
      const linesOn = l > T.impact && l < T.healed
      for (const s of shards) {
        s.glass.visible = split
        s.etch.visible = split
        s.sheen.visible = split
        s.lines.visible = linesOn
        const bob = apart * (rm ? 0.2 : 1)
        s.root.position.set(
          s.home.x + s.off.x * apart,
          s.home.y + s.off.y * apart + 0.02 * bob * Math.sin(t * 0.5 + s.phase),
          s.off.z * apart + 0.015 * bob * Math.sin(t * 0.43 + s.phase * 1.7),
        )
        q1.setFromAxisAngle(s.axis, s.tilt * apart)
        q2.setFromAxisAngle(Z, s.spin * apart)
        s.root.quaternion.copy(q1).multiply(q2)
      }

      // ---------------- crack light
      if (crackMat) {
        const u = crackMat.uniforms
        let grow = l < T.impact ? -0.01 : ease.outQuad(segment(l, T.impact, T.grown)) * 1.14
        if (l >= T.heal) grow = 1.14 * (1 - ease.inOutQuad(segment(l, T.heal, T.healed)))
        u.uGrow.value = grow
        const cool = smoothstep(0.285, 0.4, l)
        const green = smoothstep(0.575, 0.655, l)
        const col = u.uColor.value as THREE.Color
        col.copy(EMBER).lerp(COOL, cool).lerp(HEAL, green)
        u.uIntensity.value = lerp(lerp(1.6, 0.3, cool), 1.9, green)
        u.uHead.value = Math.max(1 - smoothstep(0.26, 0.3, l), smoothstep(T.heal - 0.01, T.heal + 0.01, l))
        ;(u.uHot.value as THREE.Color).copy(l < 0.5 ? HOT_BREACH : HOT_HEAL)
      }

      // ---------------- the guardian mark
      if (logo && coreMat) {
        const tall = isTall(frame)
        const w01 = wts[0] + wts[1]
        const bx = tall ? 1.05 * w01 + 1.2 * wts[2] + 1.15 * wts[3] : 2.12 * w01 + 2.42 * wts[2] + 2.18 * wts[3]
        const by = tall ? 1.55 * w01 + 1.78 * wts[2] + 1.6 * wts[3] : 0.92 * w01 + 1.12 * wts[2] + 1.02 * wts[3]
        const bz = 0.5 * w01 + 0.2 * wts[2] + 1.02 * wts[3]
        logo.root.position.set(bx, by + 0.04 * Math.sin(t * 0.7), bz)
        const face = -0.42 * wts[1] - 0.15 * wts[2]
        logo.root.rotation.set(0.07 * Math.sin(t * 0.45), face + 0.35 * Math.sin(t * 0.3), 0.04 * Math.sin(t * 0.37))
        const lock = smoothstep(0.84, 0.92, l)
        coreMat.emissiveIntensity = 2.4 + 1.1 * lock
      }

      // ---------------- the shield
      const sIn = outQuart(segment(l, T.shield0, T.shield1))
      shield.visible = l > T.shield0
      shield.position.set(lerp(6.2, 0, sIn), 0.015 * Math.sin(t * 0.5) * sIn, lerp(1.3, 0.62, sIn))
      shield.rotation.set(0, lerp(-0.62, 0, sIn), 0)
      if (rimMat) rimMat.uniforms.uStrength.value = 0.55 * smoothstep(0.84, 0.92, l)

      // ---------------- DOM
      if (status) {
        const breach = l >= T.impact + 0.012
        if (breach !== wasBreach) {
          status.root.classList.toggle('is-breach', breach)
          wasBreach = breach
        }
        // short screens: pull the card in so it clears the chrome and the mark
        const short = frame.height < 520
        status.offset.x = short ? 44 : 76
        status.offset.y = short ? -34 : -58
        group.updateMatrixWorld(true)
        impactW.set(IMPACT[0], IMPACT[1], FRONT).applyMatrix4(site.matrixWorld)
        status.update(impactW, ctx.camera, frame.width, frame.height, window01(l, 0.045, 0.31, 0.035))
      }
      reveal(copyA, window01(l, 0.31, 0.575, 0.05))
      setRise(title, l > 0.305 && l < 0.56)
      reveal(copyB, window01(l, 0.655, 0.955, 0.04))
      setRise(stat, l > 0.65 && l < 0.945)
    },

    camera(l: number, frame: Frame, out: CameraPose) {
      solvePose(l, frame, layout, out)
    },
  }
}
