import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise, reveal } from '../../core/dom'
import { PROCESS, STATS } from '../../content'
import { clamp, ease, lerp, segment, smoothstep, window01 } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { G, GLASS, edgeGlow, etch, glass, pane } from '../../kit/glass'
import { Beam } from './beam'
import { innerGlow, prismGeometry, wash } from './prism'
import './process.css'

/*
 * REFRACTION — "We listen first. Then we build."
 *
 * A beam of white light enters from the left and runs through four glass
 * prisms set in a gentle line, apex up / apex down like a direct-vision
 * (Amici) prism: each one tips the beam back the other way and adds a little
 * more colour. Listen, Prototype, Build, Support. After the fourth, the light
 * opens into a soft spectrum of the brand hues (rose, amber, signal, aqua,
 * iris) that lands on a frosted glass wall; the three stats resolve out of
 * the frost in front of it.
 *
 *   0.00–0.10  calm in-beat (under the cut pane), headline, the beam switches on
 *   0.10–0.78  four steps: the camera travels along the beam and settles on
 *              each prism as the light reaches it (a light sweep runs across
 *              the glass, the prism lights from within, its label glows)
 *   0.78–0.95  results: the spectrum fans onto the wall, stats come into focus
 *   0.95–1.00  calm out-beat
 *
 * Everything is derived from `local`; frame.time only drives idle float and
 * the slow shimmer of the light.
 */

// ---------------------------------------------------------------- layout

const R = 0.9 // prism circumradius
const DEPTH = 0.8 // prism extrusion
const BEVEL = 0.07
const FACE_Z = DEPTH / 2 + BEVEL + 0.004 // just proud of the front face
const HALF = R / Math.sqrt(3) // half-width of a prism at its centre line
const PX = [0, 4.2, 8.4, 12.6]
const PY = [0.22, -0.12, 0.22, -0.12]
const APEX_UP = [true, false, true, false]
/** where the spectrum lands, and the frosted wall it lands on */
const LAND = new THREE.Vector3(PX[3] + 6.1, 0.12, -1.7)
const WALL_YAW = -0.42
const WALL_W = 6.6
const WALL_H = 4.6
const WALL_D = 0.14
const WALL_BEVEL = 0.05
const SPAN = 2.3 // spectrum height where it lands

// ---------------------------------------------------------------- timeline

const A = 0.1
const B = 0.78
const S = (B - A) / PROCESS.length
/** local where the light reaches prism k (end of the segment that feeds it) */
const reachAt = (k: number) => (k === 0 ? 0.1 : A + S * (k + 0.02))
/** local where the segment feeding prism k starts to draw: the light leaves
 * each prism during its own step, so at every anchor it is seen passing
 * through the active prism and coming out with more colour */
const feedFrom = (k: number) => (k === 0 ? 0.03 : A + S * (k - 1 + 0.2))
const ANCHORS = [0, 1, 2, 3].map(k => A + S * (k + 0.55))
const STATS_AT = 0.885
const FAN = [0.745, 0.845] as const
const CARD = [0.112, 0.785] as const
const TILES = [0.83, 0.958] as const

// 10 years, $1M+, 15 — in that order
const SHOW = [STATS[0], STATS[2], STATS[1]]

// ---------------------------------------------------------------- camera keys

interface Key {
  t: number
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
  /** world point the light field gathers behind */
  focus: THREE.Vector3
  /** on the glide INTO this key, ease back by this fraction of the distance mid-way (a breath between prisms) */
  lift?: number
}
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z)
const DEG = Math.PI / 180
const _f = new THREE.Vector3()
const _r = new THREE.Vector3()
const _u = new THREE.Vector3()
const UP = new THREE.Vector3(0, 1, 0)

/**
 * A key orbiting `c`: azimuth phi (degrees, + = from the left-front),
 * distance d, elevation, and a screen offset (NDC-ish, -1..1) where `c`
 * should sit in the frame.
 */
function orbit(t: number, c: THREE.Vector3, phi: number, d: number, elev: number, sx: number, sy: number, aspect: number, fov: number, focus = c): Key {
  const p = phi * DEG
  const e = elev * DEG
  const pos = V(c.x - Math.sin(p) * Math.cos(e) * d, c.y + Math.sin(e) * d, c.z + Math.cos(p) * Math.cos(e) * d)
  _f.subVectors(c, pos).normalize()
  _r.crossVectors(_f, UP).normalize()
  _u.crossVectors(_r, _f)
  const halfH = Math.tan((fov * DEG) / 2) * d
  const tgt = c.clone().addScaledVector(_r, -sx * halfH * aspect).addScaledVector(_u, -sy * halfH)
  return { t, pos, tgt, fov, focus: focus.clone() }
}

function keysFor(aspect: number): Key[] {
  const portrait = aspect < 0.9
  const k: Key[] = []
  const mid = V(PX[3] + 3.1, 0, -0.7)
  if (!portrait) {
    const narrow = clamp((1.6 - aspect) / 0.6) // 0 at 16:10, 1 at 1:1
    const back = 1 + 0.18 * narrow
    const sx = 0.22 + 0.1 * narrow
    const row = V(6.3, 0, 0)
    const wide = 1 + 0.32 * narrow
    k.push(orbit(0, row, 42, 15 * wide, 6, 0.25 + 0.1 * narrow, -0.1, aspect, 34, V(4.5, 0, 0)))
    k.push(orbit(0.085, row, 43, 14.3 * wide, 6, 0.25 + 0.1 * narrow, -0.09, aspect, 34, V(4.5, 0, 0)))
    for (let i = 0; i < 4; i++) {
      const c = V(PX[i], PY[i], 0)
      const kin = orbit(A + S * (i + 0.35), c, 40, 6.7 * back, 8, sx, 0.04, aspect, 34)
      if (i > 0) kin.lift = 0.22
      k.push(kin)
      k.push(orbit(A + S * (i + 0.72), c, 38, 6.45 * back, 8, sx, 0.04, aspect, 34))
    }
    k.push(orbit(0.86, mid, 4, 11.2 * back, 7, 0, 0.2, aspect, 36, LAND))
    k.push(orbit(0.95, mid, 7, 10.8 * back, 7, 0, 0.2, aspect, 36, LAND))
    k.push(orbit(1, mid, 8, 11.1 * back, 7.5, 0, 0.2, aspect, 36, LAND))
  } else {
    const tall = clamp((0.62 - aspect) / 0.16) // 0 at tablet, 1 at phone
    const back = 1 + 0.1 * tall
    const p1 = V(PX[0], PY[0], 0)
    const sy = lerp(0.2, 0.27, tall)
    k.push(orbit(0, p1, 34, 9.2 * back, 7, -0.06, -0.22, aspect, 46, V(1.5, 0, 0)))
    k.push(orbit(0.085, p1, 32, 8.8 * back, 7, -0.05, -0.21, aspect, 46, V(1.5, 0, 0)))
    for (let i = 0; i < 4; i++) {
      const c = V(PX[i], PY[i], 0)
      const kin = orbit(A + S * (i + 0.35), c, 22, 7.7 * back, 6, 0, sy, aspect, 44)
      // portrait frames are narrow: pull well back mid-glide so both prisms share the frame
      if (i > 0) kin.lift = 0.9
      k.push(kin)
      k.push(orbit(A + S * (i + 0.72), c, 20, 7.45 * back, 6, 0, sy, aspect, 44))
    }
    k.push(orbit(0.86, mid, 50, 13.5 * back, 8, 0.1, 0.33, aspect, 46, LAND))
    k.push(orbit(0.95, mid, 48, 13.1 * back, 8, 0.1, 0.33, aspect, 46, LAND))
    k.push(orbit(1, mid, 47, 13.4 * back, 8.5, 0.1, 0.33, aspect, 46, LAND))
  }
  return k
}

const smoother = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

function sample(keys: Key[], local: number, pos: THREE.Vector3, tgt: THREE.Vector3, focus: THREE.Vector3): number {
  if (local <= keys[0].t) {
    pos.copy(keys[0].pos)
    tgt.copy(keys[0].tgt)
    focus.copy(keys[0].focus)
    return keys[0].fov
  }
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (local <= b.t) {
      const u = segment(local, a.t, b.t)
      const e = smoother(u)
      pos.lerpVectors(a.pos, b.pos, e)
      tgt.lerpVectors(a.tgt, b.tgt, e)
      focus.lerpVectors(a.focus, b.focus, e)
      if (b.lift) {
        // back away from the target along the view line, peaking mid-glide
        const lift = 1 + b.lift * Math.sin(Math.PI * e)
        pos.sub(tgt).multiplyScalar(lift).add(tgt)
      }
      return lerp(a.fov, b.fov, e)
    }
  }
  const z = keys[keys.length - 1]
  pos.copy(z.pos)
  tgt.copy(z.tgt)
  focus.copy(z.focus)
  return z.fov
}

// ---------------------------------------------------------------- chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  const rig = new THREE.Group()
  group.add(rig)

  let ctxRef: ChapterContext | null = null
  const prisms: THREE.Mesh[] = []
  const rimMats: THREE.ShaderMaterial[] = []
  const prismMats: THREE.MeshPhysicalMaterial[] = []
  const glowMats: THREE.ShaderMaterial[] = []
  const rims: THREE.Mesh[] = []
  const inners: THREE.Mesh[] = []
  const labels: { word: THREE.MeshBasicMaterial; num: THREE.MeshBasicMaterial }[] = []
  const feeds: Beam[] = []
  let fan: Beam
  let washMesh: ReturnType<typeof wash>
  let wall: THREE.Mesh

  // DOM
  let head: HTMLElement, headline: HTMLElement
  let card: HTMLElement
  const stepEls: HTMLElement[] = []
  const stepTitles: HTMLElement[] = []
  const fills: HTMLElement[] = []
  const segs: HTMLElement[] = []
  let statsEl: HTMLElement
  const tiles: HTMLElement[] = []
  let shown = -2
  const fillCache: string[] = ['', '', '', '']

  const tmpPos = new THREE.Vector3()
  const tmpTgt = new THREE.Vector3()
  const tmpFocus = new THREE.Vector3()
  const scratch = new THREE.PerspectiveCamera(40, 1, 0.1, 200)
  let keys: Key[] = []
  let keysAspect = -1

  return {
    id: 'process',
    group,
    // the four steps, then the stats
    anchors: [...ANCHORS, STATS_AT],

    async init(ctx) {
      ctxRef = ctx
      const mobile = ctx.mobile

      // ---- prisms (the label is engraved on each front face)
      const geo = prismGeometry(R, DEPTH, BEVEL, mobile)
      const base = GLASS.clear()
      for (let i = 0; i < 4; i++) {
        const m = base.clone()
        m.dispersion = base.dispersion * 1.4
        // a crisp second reflection layer and a thicker optical body: prisms bend hard
        m.clearcoat = 0.7
        m.clearcoatRoughness = 0.03
        m.thickness = 1.25
        m.ior = 1.56
        prismMats.push(m)
        const p = new THREE.Mesh(geo, m)
        p.position.set(PX[i], PY[i], 0)
        p.rotation.z = APEX_UP[i] ? 0 : Math.PI
        rig.add(p)
        prisms.push(p)
        const rm = edgeGlow('#effff8', 3.4, 0)
        rimMats.push(rm)
        const rim = new THREE.Mesh(geo, rm)
        rim.scale.setScalar(1.003)
        rim.renderOrder = 4
        p.add(rim)
        rims.push(rim)

        // engraved on the face: the word in the wide part, the number in the narrow part
        const word = etch(PROCESS[i].title, { height: 0.175, weight: 520, color: G.white, glow: 1.6, opacity: 0.95, letterSpacing: -0.01 })
        const num = etch(String(i + 1).padStart(2, '0'), {
          height: 0.1,
          weight: 500,
          font: "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace",
          color: G.mint,
          glow: 1.6,
          opacity: 0.95,
          letterSpacing: 0.08,
        })
        // (apex-down faces are seen from above: sit the word a little higher, clear of the beam)
        word.position.set(0, APEX_UP[i] ? -0.25 : -0.315, FACE_Z)
        num.position.set(0, APEX_UP[i] ? 0.21 : 0.19, FACE_Z)
        // apex-down prisms are turned over: turn the engraving back upright
        if (!APEX_UP[i]) {
          word.rotation.z = Math.PI
          num.rotation.z = Math.PI
        }
        word.renderOrder = 5
        num.renderOrder = 5
        p.add(word, num)
        labels.push({ word: word.material as THREE.MeshBasicMaterial, num: num.material as THREE.MeshBasicMaterial })

        // light scattering inside the glass while the beam runs through it
        const inner = innerGlow(0.9)
        inner.position.set(0, 0, 0)
        inner.renderOrder = 3
        p.add(inner)
        inners.push(inner)
        glowMats.push(inner.material)
      }
      await nextFrame()

      // ---- the light: source → P1, P1 → P2, P2 → P3, P3 → P4. Ribbons end
      // at each prism's centre; the glass occludes the part inside it.
      const C = PX.map((x, i) => V(x, PY[i], 0))
      const src = V(PX[0] - 13, PY[0] - 1.25, 0)
      const splits: [number, number][] = [
        [0, 0],
        [0.008, 0.024],
        [0.026, 0.055],
        [0.056, 0.1],
      ]
      for (let k = 0; k < 4; k++) {
        const b = new Beam({
          core0: 0.011,
          core1: 0.012,
          split0: splits[k][0],
          split1: splits[k][1],
          halo: 4.5,
          haloAmount: 0.13,
          inStart: k === 0 ? 0 : HALF * 1.05,
          inEnd: HALF * 1.05,
          inside: 0.5,
        })
        b.place(k === 0 ? src : C[k - 1], C[k])
        rig.add(b.mesh)
        feeds.push(b)
      }

      // ---- the frosted wall, turned a little toward the incoming light
      const n = V(Math.sin(WALL_YAW), 0, Math.cos(WALL_YAW))
      const along = V(Math.cos(WALL_YAW), 0, -Math.sin(WALL_YAW))
      const front = WALL_D / 2 + WALL_BEVEL
      wall = pane(WALL_W, WALL_H, {
        radius: 0.34,
        depth: WALL_D,
        bevel: WALL_BEVEL,
        material: glass({ frost: 0.36, thickness: 0.22, dispersion: 0, env: 0.9, ior: 1.45 }),
      })
      wall.position.copy(LAND).addScaledVector(along, 0.9).addScaledVector(n, -front)
      wall.position.y = LAND.y - 0.05
      wall.rotation.y = WALL_YAW
      rig.add(wall)
      washMesh = wash(WALL_W * 0.94, WALL_H * 0.92, SPAN)
      washMesh.position.copy(wall.position).addScaledVector(n, front + 0.006)
      washMesh.rotation.y = WALL_YAW
      washMesh.material.uniforms.uLand.value = -0.9
      rig.add(washMesh)

      // the spectrum: P4 → the wall, spreading vertically
      const hit = LAND.clone().addScaledVector(n, 0.004)
      fan = new Beam({ core0: 0.016, core1: SPAN * 0.1, split0: 0.1, split1: SPAN, halo: 2.4, haloAmount: 0.3, fadeEnd: 0.97, fadeStart: 0.001, inStart: HALF * 1.05, inside: 0.45 })
      fan.place(C[3], hit)
      rig.add(fan.mesh)
      await nextFrame()

      // ---- DOM
      const stage = ctx.stage
      head = el('div', 'pr-head', undefined, stage)
      el('p', 'hud-eyebrow', 'How we work', head)
      headline = rise(el('h2', 'hud-h2 pr-headline', undefined, head), 'We listen first. <em>Then we build.</em>')

      card = el('div', 'pr-card hud-panel hud-panel--strong', undefined, stage)
      const top = el('div', 'pr-card-top', undefined, card)
      el('p', 'hud-label', 'How we work', top)
      el('p', 'hud-label pr-of', `${String(PROCESS.length).padStart(2, '0')} steps`, top)
      const steps = el('div', 'pr-steps', undefined, card)
      PROCESS.forEach((p, i) => {
        const s = el('div', 'pr-step', undefined, steps)
        const n2 = String(i + 1).padStart(2, '0')
        stepTitles.push(rise(el('h3', 'pr-title', undefined, s), `<em>${n2}</em> — ${p.title}`))
        el('p', 'hud-body pr-text', p.text, s)
        stepEls.push(s)
      })
      const track = el('ol', 'pr-track', undefined, card)
      PROCESS.forEach(p => {
        const li = el('li', 'pr-seg', undefined, track)
        const bar = el('span', 'pr-bar', undefined, li)
        fills.push(el('span', 'pr-fill', undefined, bar))
        el('span', 'pr-name', p.title, li)
        segs.push(li)
      })

      statsEl = el('div', 'pr-stats', undefined, stage)
      SHOW.forEach((s, i) => {
        const t = el('div', 'pr-tile hud-panel hud-panel--strong', undefined, statsEl)
        t.style.setProperty('--i', String(i))
        el('p', 'pr-value', s.value, t)
        el('p', 'pr-label', s.label, t)
        tiles.push(t)
      })
      reveal(head, 0, 0)
      reveal(card, 0, 0)
      reveal(statsEl, 0, 0)
    },

    update(local, frame, ctx) {
      const rm = frame.reducedMotion
      const t = frame.time
      const flow = rm ? 0 : 1

      // ---- beat state
      const inSteps = local >= A && local <= B
      const idx = clamp(Math.floor((local - A) / S), 0, 3)
      const phase = clamp((local - A - idx * S) / S)
      // how strongly each prism is the active one
      const act = [0, 1, 2, 3].map(k => window01(local, A + S * k - 0.012, A + S * (k + 1) + 0.012, 0.045))
      const results = smoothstep(0.77, 0.86, local)
      // the last prism stays lit: it is the source of the spectrum
      act[3] = Math.max(act[3], results * 0.75)
      // has the light reached prism k?
      const lit = [0, 1, 2, 3].map(k => smoothstep(reachAt(k) - 0.025, reachAt(k) + 0.01, local))
      const intro = 1 - smoothstep(0.09, 0.16, local)

      // ---- rig idle float (slow, weightless)
      rig.position.y = Math.sin(t * (rm ? 0.12 : 0.42)) * (rm ? 0.01 : 0.035)

      // ---- prisms
      for (let k = 0; k < 4; k++) {
        const p = prisms[k]
        // arrival: a slow turntable glide that settles as the light reaches it
        const arrive = ease.outCubic(segment(local, reachAt(k) - 0.08, reachAt(k) + 0.05))
        const sway = rm ? 0 : Math.sin(t * 0.3 + k * 1.7) * 0.02
        p.rotation.y = lerp(0.06, -0.36, arrive) + sway
        const a = act[k]
        prismMats[k].envMapIntensity = 1.2 + 0.5 * a
        const rimS = 0.12 * lit[k] + 0.55 * a
        rimMats[k].uniforms.uStrength.value = rimS
        rims[k].visible = rimS > 0.002
        const glowS = lit[k] * (0.07 + 0.15 * a)
        glowMats[k].uniforms.uStrength.value = glowS
        inners[k].visible = glowS > 0.002
        // the engraving: frosted when dark, edge-lit when the beam runs through
        const L = labels[k]
        const glowAmt = 0.42 + 0.25 * lit[k] + 0.75 * a
        L.word.color.set(G.white).multiplyScalar(glowAmt)
        L.num.color.set(G.mint).multiplyScalar(glowAmt * 1.1)
      }

      // ---- the light
      for (let k = 0; k < 4; k++) {
        const r = segment(local, feedFrom(k), reachAt(k))
        const rev = k === 0 ? ease.outCubic(r) : ease.inOutQuad(r)
        const boost = k === idx && inSteps ? act[k] : 0
        const after = k > 0 && k - 1 === idx && inSteps ? act[k - 1] * 0.5 : 0
        feeds[k].set((k === 0 ? 1.3 : 1.5) + 0.8 * boost + after + 0.3 * results, rev, t, flow)
      }
      const fanRev = ease.inOutQuad(segment(local, FAN[0], FAN[1]))
      fan.set(1.5, fanRev, t, flow)
      const land = smoothstep(FAN[1] - 0.05, FAN[1] + 0.03, local)
      const wu = washMesh.material.uniforms
      wu.uIntensity.value = land
      wu.uTime.value = t
      wu.uFlow.value = flow
      washMesh.visible = land > 0.001

      // ---- world: a dark studio; the beam is the light
      const w = ctx.world.params
      w.base = '#03050a'
      w.a = results > 0.5 ? G.iris : G.aqua
      w.b = results > 0.5 ? G.rose : G.iris
      w.c = '#10305a'
      w.d = results > 0.5 ? G.amber : G.rose
      w.glow = lerp(0.4 + 0.08 * intro, 0.62, results)
      w.flow = rm ? 0.2 : 0.7
      w.spread = lerp(0.8, 1.1, results)
      w.strips = lerp(lerp(0.6, 0.66, intro), 0.3, results)
      w.stripColor = '#e8fff4'
      w.env = 1.35 + 0.15 * intro
      // light sweeps: each arrival runs the studio highlights across the glass
      let turn = 0.35
      for (let k = 0; k < 4; k++) turn += 0.6 * ease.outCubic(segment(local, reachAt(k) - 0.03, reachAt(k) + 0.06))
      turn += 0.5 * ease.outCubic(segment(local, FAN[0], 0.9))
      w.envTurn = rm ? 0.35 + (turn - 0.35) * 0.25 : turn
      w.keyDir.set(-0.55, 0.75, 0.6)
      w.key = 1.7
      w.fill = 0.25

      // ---- post
      const post = ctx.post.params
      post.bloomStrength = 0.46
      post.bloomRadius = 0.55
      post.bloomThreshold = 0.9
      post.vignette = 0.36
      // a focus pull as the spectrum opens: frost, then clear for the stats
      post.frost = rm ? 0 : 0.26 * Math.max(0, Math.sin(Math.PI * segment(local, 0.765, 0.85)))

      // ---- DOM
      // portrait: the headline gives way to the card (the prism needs the room between)
      const headEnd = frame.height > frame.width * 1.1 ? 0.15 : 0.235
      reveal(head, window01(local, 0.045, headEnd, 0.03), 0)
      setRise(headline, local > 0.05 && local < headEnd - 0.01)

      const cardV = window01(local, CARD[0], CARD[1], 0.018)
      reveal(card, cardV, 0)
      const cur = local > CARD[0] && local < CARD[1] ? idx : -1
      if (cur !== shown) {
        shown = cur
        stepEls.forEach((s, i) => s.classList.toggle('is-on', i === cur))
        segs.forEach((s, i) => {
          s.classList.toggle('is-on', i === cur)
          s.classList.toggle('is-done', cur >= 0 && i < cur)
        })
      }
      stepTitles.forEach((h, i) => setRise(h, i === cur && cardV > 0.05))
      for (let i = 0; i < 4; i++) {
        const f = i < idx ? 1 : i === idx ? (inSteps ? ease.outCubic(clamp(phase / 0.55)) : local > B ? 1 : 0) : 0
        const s = `scaleX(${f.toFixed(3)})`
        if (fillCache[i] !== s) {
          fillCache[i] = s
          fills[i].style.transform = s
        }
      }

      const tilesOn = local > TILES[0] && local < TILES[1]
      reveal(statsEl, window01(local, TILES[0] - 0.01, TILES[1] + 0.005, 0.02), 0)
      tiles.forEach(tile => tile.classList.toggle('is-on', tilesOn))
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const aspect = frame.width / Math.max(1, frame.height)
      if (Math.abs(aspect - keysAspect) > 1e-3) {
        keys = keysFor(aspect)
        keysAspect = aspect
      }
      const fov = sample(keys, local, tmpPos, tmpTgt, tmpFocus)
      out.position.copy(tmpPos)
      out.target.copy(tmpTgt)
      out.fov = fov
      out.roll = 0
      out.parallax = frame.reducedMotion ? 0 : 0.26

      // gather the light field behind the subject (field space: x = ndc.x * aspect)
      if (ctxRef) {
        scratch.position.copy(tmpPos)
        scratch.fov = fov
        scratch.aspect = aspect
        scratch.updateProjectionMatrix()
        scratch.lookAt(tmpTgt)
        scratch.updateMatrixWorld()
        tmpFocus.project(scratch)
        if (Number.isFinite(tmpFocus.x) && Number.isFinite(tmpFocus.y)) {
          ctxRef.world.params.focus.set(clamp(tmpFocus.x, -1.2, 1.2) * aspect, clamp(tmpFocus.y, -0.9, 0.9))
        }
      }
    },
  }
}
