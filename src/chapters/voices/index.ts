import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { el, rise, setRise } from '../../core/dom'
import { clamp, lerp, remap, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { SECTIONS, TESTIMONIALS } from '../../content'
import { G } from '../../kit/glass'
import {
  ETCH_Y,
  PANE_D,
  PANE_H,
  FLOOR_Y,
  N,
  etchFontsReady,
  makeEdgeLine,
  makeEtch,
  makeFloor,
  makePaneGeometry,
  makeQuoteMark,
  paneMaterial,
  paneSpot,
  paneYaw,
  type Etch,
  type Floor,
  type QuoteMark,
} from './hall'
import './voices.css'

/*
 * REFLECTIONS (voices) — a quiet hall of tall glass panes standing in depth,
 * one per client, each carrying the client's initials as edge-lit etching.
 * A thick glass “ floats at the front and refracts the warm light and the
 * etched letters behind it.
 *
 *   0.00–0.085  intro: the hall seen down its length, “We listen. They talk.”
 *   0.085–0.92  eight voices (~0.104 each). As each voice's quote comes into
 *               focus in the frosted panel, the camera glides to its pane
 *               (long ease-out, light sweep across the glass, a breath of
 *               frost) and the pane lights up; then everything holds.
 *   0.92–1.00   out: the last panes glide into one slab, the etching and the
 *               light calm down for the cut.
 *
 * Everything is derived from `local`; frame.time only drives the idle float.
 */

const B0 = 0.085
const B1 = 0.92
const SPAN = (B1 - B0) / N
/** scroll hysteresis around every card boundary */
const HYST = 0.006
/** the out-beat: panes align into one */
const OUT0 = 0.922
const OUT1 = 0.968

/** gentle start, quick middle, long settle (zero velocity at both ends) */
const glide = (t: number) => {
  const x = clamp(t)
  const u = 1 - x
  return 1 - u * u * u * u * (1 + 4 * x)
}

/**
 * The camera's glide window into pane i, placed so the eased glide is exactly
 * halfway where the copy switches voice: at rest, the pane nearest the camera
 * always belongs to the quote in the panel. Fast start, long settle. The
 * first glide leaves the intro only once the headline hands over.
 */
const GLIDE_W = 0.42 * SPAN
/** raw progress at which glide() crosses 0.5 */
const GLIDE_HALF = 0.3138
function glideWin(i: number): [number, number] {
  const b = B0 + i * SPAN
  if (i === 0) return [b, b + 0.062]
  const a = b - GLIDE_HALF * GLIDE_W
  return [a, a + GLIDE_W]
}

interface Track {
  /** pose we come from (-1 intro, 0..N-1 panes, N out) */
  from: number
  to: number
  /** raw 0..1 through the glide */
  raw: number
  /** eased */
  t: number
  /** continuous position: from + t */
  s: number
}

function trackAt(local: number, out: Track): Track {
  out.from = -1
  out.to = -1
  out.raw = 0
  out.t = 0
  if (local >= OUT0) {
    const raw = clamp((local - OUT0) / (OUT1 - OUT0))
    out.from = N - 1
    out.to = N
    out.raw = raw
    out.t = glide(raw)
  } else {
    for (let i = 0; i < N; i++) {
      const [a, b] = glideWin(i)
      if (local < a) break
      out.from = i - 1
      out.to = i
      out.raw = clamp((local - a) / (b - a))
      out.t = glide(out.raw)
      if (local < b) break
      out.from = i
      out.raw = 0
      out.t = 0
    }
  }
  out.s = out.from + (out.to - out.from) * out.t
  return out
}

/** 0 = landscape layout, 1 = portrait (mirrors voices.css) */
const portraitK = (f: Frame) => clamp(remap(f.width / Math.max(1, f.height), 1.02, 0.86))

interface Pose {
  pos: THREE.Vector3
  tgt: THREE.Vector3
  fov: number
  /** quote mark: position, scale */
  mark: THREE.Vector3
  markScale: number
}
const mkPose = (): Pose => ({ pos: new THREE.Vector3(), tgt: new THREE.Vector3(), fov: 32, mark: new THREE.Vector3(), markScale: 1 })

export default function create(): Chapter {
  const group = new THREE.Group()
  const hall = new THREE.Group()
  group.add(hall)

  const paneRoots: THREE.Group[] = []
  const etches: Etch[] = []
  const edges: { top: { value: number }; foot: { value: number } }[] = []
  let floor: Floor
  let mark: QuoteMark
  const markRoot = new THREE.Group()

  // DOM
  let intro: HTMLElement
  let introTitle: HTMLElement

  let panel: HTMLElement
  let stack: HTMLElement
  let count: HTMLElement
  let dots: HTMLElement[] = []
  const cards: { root: HTMLElement; parts: HTMLElement[]; h: number }[] = []
  let shown = -2 // -2 = fresh, -1 = intro, 0..N-1 = card, N = out
  let meta: HTMLElement
  /** measured layout (px): read only on resize / card-size changes */
  const lay = { safeTop: 0, panelBottom: 0, maxPanel: 0, h: 0 }
  let stackH = -1
  let deferShow = 0

  const trk: Track = { from: -1, to: -1, raw: 0, t: 0, s: -1 }
  const pa = mkPose()
  const pb = mkPose()
  const tmp = new THREE.Vector3()
  const hallPos = new THREE.Vector3()
  const stackPos = new THREE.Vector3()
  const lastPos = new THREE.Vector3()

  /* ------------------------------------------------------------ poses */

  /** where pose k puts the camera and the quote mark for this viewport */
  function poseFor(k: number, f: Frame, out: Pose) {
    const aspect = f.width / Math.max(1, f.height)
    const pk = portraitK(f)
    if (k < 0) {
      // intro: down the length of the hall, panes receding to the left
      const p0 = paneSpot(0, tmp)
      const land = { px: p0.x + 2.3, py: 1.25, pz: p0.z + 9.6, tx: p0.x - 2.2, ty: -0.05, tz: p0.z - 3.2, fov: 33 }
      const port = { px: p0.x + 1.2, py: 1.6, pz: p0.z + 11.2, tx: p0.x - 1.2, ty: -0.75, tz: p0.z - 3.0, fov: 44 }
      out.pos.set(lerp(land.px, port.px, pk), lerp(land.py, port.py, pk), lerp(land.pz, port.pz, pk))
      out.tgt.set(lerp(land.tx, port.tx, pk), lerp(land.ty, port.ty, pk), lerp(land.tz, port.tz, pk))
      out.fov = lerp(land.fov, port.fov, pk)
      // the mark hangs in front of the first pane
      out.mark.set(p0.x + lerp(1.05, 0.2, pk), lerp(0.55, 0.9, pk), p0.z + lerp(3.4, 3.6, pk))
      out.markScale = lerp(1.45, 1.15, pk)
      return out
    }
    const last = k >= N
    const i = Math.min(k, N - 1)
    const P = paneSpot(i, tmp)
    // landscape: the pane sits in the free area right of the copy panel
    const w = f.width
    const gutter = clamp(0.034 * w, 16, 48)
    const panelRight = gutter + Math.min(500, 0.38 * w)
    const freeCentre = (panelRight + w) / 2
    const ndcX = last ? 0.0 : clamp((freeCentre / w) * 2 - 1 + 0.04, 0.1, 0.5)
    const lFov = 30
    const lD = last ? 10.2 : 8.7
    const lHalfW = lD * Math.tan(THREE.MathUtils.degToRad(lFov / 2)) * aspect
    const lOff = ndcX * lHalfW
    // portrait: the pane centred; the cluster (quote mark over the etched
    // initials) framed in the window between the chrome and the copy panel,
    // sized for the TALLEST quote so the framing never changes between voices
    const pFov = 40
    const tanP = Math.tan(THREE.MathUtils.degToRad(pFov / 2))
    const H = f.height
    // stage px (from the top) map straight onto the canvas, which shares its top edge
    const measured = lay.h > 0
    const top = measured ? lay.safeTop : clamp(0.105 * H, 80, 112)
    const bot = (measured ? lay.panelBottom - lay.maxPanel : H - clamp(0.105 * H, 82, 110) - 0.36 * H) - 12
    const regionH = Math.max(140, bot - top)
    const cy = 1 - (2 * (top + bot)) / 2 / H
    const pD = last ? 9.6 : Math.max(7.2, (1.8 * H) / (2 * 0.9 * regionH) / tanP)
    const pHalfH = pD * tanP
    const pTy = last ? -0.2 : 0.42 - cy * pHalfH
    out.pos.set(P.x - lerp(lOff, 0, pk), lerp(0.42, pTy + 0.55, pk), P.z + lerp(lD, pD, pk))
    out.tgt.set(P.x - lerp(lOff, 0, pk), lerp(0.08, pTy, pk), P.z)
    out.fov = lerp(lFov, pFov, pk)
    // the quote mark: in front of the pane's upper-left corner, overlapping the initials
    if (last) {
      out.mark.set(P.x, lerp(0.1, 0.35, pk), P.z + 2.2)
      out.markScale = lerp(0.8, 0.7, pk)
    } else {
      out.mark.set(P.x + lerp(-0.9, -0.42, pk), lerp(0.62, 0.64, pk), P.z + lerp(1.75, 1.0, pk))
      out.markScale = lerp(0.96, 0.64, pk)
    }
    return out
  }

  /* -------------------------------------------------------------- DOM */

  function buildDom(stage: HTMLElement) {
    intro = el('div', 'vc-intro', undefined, stage)
    el('p', 'hud-eyebrow vc-eyebrow', SECTIONS.voices.eyebrow, intro)
    const m = SECTIONS.voices.title.match(/^(.*?\.)\s+(.*)$/)
    const html = m ? `${m[1]} <em>${m[2]}</em>` : SECTIONS.voices.title
    introTitle = rise(el('h2', 'hud-h2 vc-title', undefined, intro), html)

    panel = el('figure', 'vc-panel hud-panel hud-panel--strong', undefined, stage)
    meta = el('div', 'vc-meta', undefined, panel)
    count = el('p', 'vc-count', '', meta)
    const dotsWrap = el('div', 'vc-dots', undefined, meta)
    dots = TESTIMONIALS.map(() => el('i', '', undefined, dotsWrap))
    stack = el('div', 'vc-stack', undefined, panel)
    TESTIMONIALS.forEach(t => {
      const root = el('div', 'vc-card', undefined, stack)
      if (t.quote.length > 170) root.classList.add('vc-card--long')
      const q = rise(el('blockquote', 'hud-quote vc-quote', undefined, root), `“${t.quote}”`)
      const who = el('p', 'vc-who', undefined, root)
      const name = rise(el('span', 'hud-label vc-name', undefined, who), t.name)
      const co = rise(el('span', 'hud-label vc-co', undefined, who), t.company)
      cards.push({ root, parts: [q, name, co], h: 0 })
    })
    // card heights drive the panel's height glide (measured only on change)
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(entries => {
        for (const e of entries) {
          const c = cards.find(k => k.root === e.target)
          if (c) c.h = (e.target as HTMLElement).offsetHeight
        }
        applyStackHeight()
        measure()
      })
      cards.forEach(c => ro.observe(c.root))
      ro.observe(meta)
    }
    window.addEventListener('resize', measure)
    measure()
  }

  function measure() {
    const cs = getComputedStyle(panel)
    const gap = parseFloat(cs.rowGap) || 0
    const chrome = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + gap + meta.offsetHeight
    let tallest = 0
    for (const c of cards) tallest = Math.max(tallest, c.h || c.root.offsetHeight)
    lay.safeTop = intro.offsetTop
    lay.panelBottom = panel.offsetTop + panel.offsetHeight
    lay.maxPanel = chrome + tallest
    lay.h = window.innerHeight
  }

  /** glide the panel to the shown card's height (snap when it is appearing) */
  function applyStackHeight(snap = false) {
    if (shown < 0 || shown >= N) return
    const c = cards[shown]
    const h = c.h || (c.h = c.root.offsetHeight)
    if (h && h !== stackH) {
      stackH = h
      if (snap) stack.style.transition = 'none'
      stack.style.height = `${h}px`
      if (snap) {
        void stack.offsetHeight // commit the snapped height before restoring the glide
        stack.style.transition = ''
      }
    }
  }

  function setCard(i: number, on: boolean) {
    const c = cards[i]
    if (!c) return
    c.root.classList.toggle('is-on', on)
    for (const p of c.parts) setRise(p, on)
  }

  function sinkAll() {
    for (let i = 0; i < N; i++) setCard(i, false)
    setRise(introTitle, false)
    intro.classList.remove('is-on')
    panel.classList.remove('is-on')
    shown = -2
    stackH = -1
  }

  function wantAt(local: number) {
    let want = local < B0 ? -1 : local >= B1 ? N : Math.min(N - 1, Math.floor((local - B0) / SPAN))
    if (shown >= -1 && want !== shown && Math.abs(want - shown) === 1) {
      const hi = Math.max(want, shown)
      const boundary = hi >= N ? B1 : B0 + hi * SPAN
      if (Math.abs(local - boundary) < HYST) want = shown
    }
    return want
  }

  function show(next: number) {
    if (next === shown) return
    const wasCard = shown >= 0 && shown < N
    if (wasCard) setCard(shown, false)
    shown = next
    const isCard = next >= 0 && next < N
    panel.classList.toggle('is-on', isCard)
    if (isCard) {
      setCard(next, true)
      count.innerHTML = `<b>${String(next + 1).padStart(2, '0')}</b> / ${String(N).padStart(2, '0')}`
      dots.forEach((d, i) => {
        d.classList.toggle('is-on', i === next)
        d.classList.toggle('is-past', i < next)
      })
      applyStackHeight(!wasCard)
    }
  }

  /* ----------------------------------------------------------- chapter */

  return {
    id: 'voices',
    group,
    // keyboard stops land on each voice once the camera has settled and the quote is sharp
    anchors: TESTIMONIALS.map((_, i) => B0 + SPAN * (i + 0.62)),

    async init(ctx: ChapterContext) {
      buildDom(ctx.stage)
      const mobile = ctx.mobile
      const fontsOk = await etchFontsReady()
      const geo = makePaneGeometry()
      const mat = paneMaterial()
      for (let i = 0; i < N; i++) {
        const root = new THREE.Group()
        const p = new THREE.Mesh(geo, mat)
        const e = makeEtch(i, mobile)
        // the etch sits inside the slab (between its faces), the mirror under the floor
        e.mesh.position.set(0, ETCH_Y, 0)
        root.add(p, e.mesh)
        hall.add(root)
        e.mirror.position.set(0, 2 * FLOOR_Y - ETCH_Y, 0)
        root.add(e.mirror)
        if (e.face) {
          e.face.position.set(0, ETCH_Y, PANE_D / 2 + 0.004)
          root.add(e.face)
        }
        const top = makeEdgeLine(1.78)
        top.mesh.position.set(0, PANE_H / 2 - 0.022, 0)
        const foot = makeEdgeLine(1.82)
        foot.mesh.position.set(0, -PANE_H / 2 + 0.02, 0)
        root.add(top.mesh, foot.mesh)
        edges.push({ top: top.uniforms.uIntensity, foot: foot.uniforms.uIntensity })
        paneRoots.push(root)
        etches.push(e)
        if (i % 3 === 2) await nextFrame()
      }
      if (!fontsOk) document.fonts?.ready.then(() => etches.forEach(e => e.redraw()))
      floor = makeFloor()
      group.add(floor.mesh)
      await nextFrame()
      mark = makeQuoteMark(mobile)
      markRoot.add(mark.root)
      group.add(markRoot)
    },

    onEnter() {
      // every entry replays the focus pull: sink whatever an earlier visit (or
      // the engine's prewarm) left in, and show the copy a frame later so the
      // rise transitions actually run
      sinkAll()
      deferShow = 1
    },

    onLeave() {
      sinkAll()
    },

    update(local, frame, ctx) {
      const rm = frame.reducedMotion
      const tIdle = frame.time * (rm ? 0.25 : 1)
      const tr = trackAt(local, trk)
      const pk = portraitK(frame)

      /* ---- the hall: panes, alignment out-beat, etch light ---- */
      const outA = local >= OUT0 ? tr.t : 0
      const silence = 1 - smoothstep(0.05, 0.6, outA)
      const introK = tr.s < 0 ? -tr.s : 0
      paneSpot(N - 1, lastPos)
      for (let j = 0; j < N; j++) {
        const root = paneRoots[j]
        paneSpot(j, hallPos)
        // out-beat: the nearest panes glide back along the hall onto the last
        // one (nearest first), stacked a hair apart — one slab
        const order = N - 1 - j
        const joins = order <= 2
        stackPos.copy(lastPos)
        stackPos.z -= order * 0.07
        stackPos.x += order * 0.012
        const a = joins && outA > 0 ? glide(clamp((tr.raw - order * 0.14) / 0.72)) : 0
        root.position.lerpVectors(hallPos, stackPos, a)
        root.rotation.y = lerp(paneYaw(j), 0, a)
        // idle: the faintest breathing sway (never once aligned)
        root.position.y = rm ? 0 : Math.sin(tIdle * 0.35 + j * 1.7) * 0.02 * (1 - a)
        // d > 0: already passed (leaving the frame to the right); d < 0: still ahead
        const d = tr.s - j
        const near = 1 - Math.min(1, Math.abs(d))
        const lit = near * near * (3 - 2 * near)
        const reach = ctx.mobile ? 2.6 : 4.2
        const present = tr.s < 0 ? (j < 7 ? 1 : 0) : outA > 0 && joins ? 1 : d > 0 ? 1 - clamp(d - 0.4) : 1 - clamp(-d - reach + 1)
        root.visible = present > 0.001
        // the lit voice glows, the next ones whisper, passed ones go quiet
        const whisper = d > 0 ? 0.05 * (1 - clamp(d)) : (0.05 + 0.04 * introK) * (1 - clamp((-d - 1.5) / 2.5))
        const glow = (whisper + (0.95 - whisper) * lit) * silence + (order === 0 ? 0.1 * (1 - silence) : 0)
        const ej = etches[j]
        ej.uniforms.uIntensity.value = glow * present * (ej.face ? 0.55 : 1)
        if (ej.faceUniforms) ej.faceUniforms.uIntensity.value = glow * present * 0.62
        ej.mirrorUniforms.uIntensity.value = glow * present
        // exploded view: the arriving etch floats a touch forward, then re-seats
        const pop = tr.to === j && tr.raw > 0 && tr.raw < 1 ? Math.sin(Math.PI * tr.raw) : 0
        ej.mesh.position.z = pop * 0.16 * (rm ? 0 : 1)
        if (ej.face) ej.face.position.z = PANE_D / 2 + 0.004 + pop * 0.16 * (rm ? 0 : 1)
        edges[j].top.value = (0.12 + 0.9 * lit) * present * silence
        edges[j].foot.value = (0.35 + 2.2 * lit) * present * lerp(1, 0.4, outA)
        floor.panes[j].set(root.position.x, root.position.z, root.rotation.y, (0.25 + 0.75 * lit) * present * lerp(1, 0.55, outA))
      }
      floor.uniforms.uFade.value = lerp(1, 0.6, outA)

      /* ---- the quote mark: floats in front, trails the glide, turns ---- */
      poseFor(tr.from, frame, pa)
      poseFor(tr.to, frame, pb)
      // the mark lags the camera a little, then settles
      const mt = tr.raw > 0 ? glide(clamp((tr.raw - 0.08) / 0.92)) : tr.t
      markRoot.position.lerpVectors(pa.mark, pb.mark, mt)
      // it arcs up and toward us mid-glide, like it is lifted and carried
      const arc = Math.sin(Math.PI * tr.raw) * (tr.raw > 0 && tr.raw < 1 ? 1 : 0)
      markRoot.position.y += arc * 0.28
      markRoot.position.z += arc * 0.5
      markRoot.position.y += rm ? 0 : Math.sin(tIdle * 0.55) * 0.05
      const sc = lerp(pa.markScale, pb.markScale, mt)
      markRoot.scale.setScalar(sc)
      const dir = tr.to > tr.from ? 1 : -1
      mark.root.rotation.set(
        -0.1 + (rm ? 0 : Math.sin(tIdle * 0.4) * 0.05),
        -0.32 + (rm ? 0 : Math.sin(tIdle * 0.23) * 0.16) + arc * 0.5 * dir + lerp(0, 0.32, outA),
        0.05 + (rm ? 0 : Math.sin(tIdle * 0.31) * 0.03),
      )
      // exploded view: mid-glide the two commas part in depth, then re-seat
      const ex = rm ? 0 : arc
      mark.left.position.set(-0.05 * ex, 0.02 * ex, 0.16 * ex)
      mark.right.position.set(0.07 * ex, -0.02 * ex, -0.26 * ex)

      /* ---- light: warm pools behind the subject, sweeps on arrival ---- */
      const w = ctx.world.params
      w.a = G.rose
      w.b = G.amber
      w.c = '#5b4fd6'
      w.d = '#ffcf9e'
      w.base = '#060509'
      w.stripColor = '#ffeede'
      // the field gathers behind the pane (screen space: x = ndc.x * aspect)
      const aspect = frame.width / Math.max(1, frame.height)
      const dwellFx = lerp(0.42 * aspect, 0, pk)
      const introFx = lerp(0.3 * aspect, 0.1, pk)
      const outFx = 0
      const fxOf = (k: number) => (k < 0 ? introFx : k >= N ? outFx : dwellFx)
      const fyOf = (k: number) => (k < 0 ? lerp(0.0, -0.05, pk) : k >= N ? 0.02 : lerp(0.06, 0.34, pk))
      w.focus.set(lerp(fxOf(tr.from), fxOf(tr.to), tr.t), lerp(fyOf(tr.from), fyOf(tr.to), tr.t))
      w.spread = lerp(1.12, 0.85, pk) * lerp(1, 1.2, outA)
      w.glow = lerp(lerp(0.3, 0.25, pk), 0.22, outA)
      w.flow = rm ? 0.25 : 0.55
      w.strips = lerp(1.0, 0.45, outA)
      // light sweeps: each arrival runs the studio round a little (scroll-derived)
      const sweeps = tr.from + 1 + tr.t // 0 → N+1 across the chapter
      w.envTurn = 0.6 + sweeps * (rm ? 0.18 : 0.62)
      w.env = 1.15 + (rm ? 0 : 0.35 * arc)
      w.key = 1.5
      w.keyDir.set(-0.55, 0.75, 0.6)
      w.fill = 0.28

      const post = ctx.post.params
      post.bloomStrength = 0.48
      post.bloomRadius = 0.6
      post.vignette = 0.34
      // a breath of frost mid-glide: a focus pull between voices
      post.frost = rm ? 0 : 0.12 * arc * (tr.from >= 0 && tr.to < N ? 1 : 0.5)

      /* ---- DOM ---- */
      if (deferShow > 0) {
        deferShow--
        return
      }
      show(wantAt(local))
      setRise(introTitle, shown === -1 && local > 0.012)
      intro.classList.toggle('is-on', shown === -1)
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const tr = trackAt(local, trk)
      poseFor(tr.from, frame, pa)
      poseFor(tr.to, frame, pb)
      out.position.lerpVectors(pa.pos, pb.pos, tr.t)
      out.target.lerpVectors(pa.tgt, pb.tgt, tr.t)
      // mid-glide the camera eases back a touch: a dolly, not a slide
      const arc = tr.raw > 0 && tr.raw < 1 ? Math.sin(Math.PI * tr.raw) : 0
      out.position.z += arc * 0.9
      out.position.y += arc * 0.15
      out.fov = lerp(pa.fov, pb.fov, tr.t)
      out.roll = 0
      out.parallax = frame.reducedMotion ? 0 : 0.28
    },
  }
}
