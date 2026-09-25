import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal, rise, setRise } from '../../core/dom'
import { BRAND, MICROCOPY } from '../../content'
import { clamp, lerp, segment, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { G } from '../../kit/glass'
import { MARK_S, MARK_Y, buildMark, buildStage, type HeroSet } from './scene'
import './hero.css'

/*
 * HERO — "Lens". The Hark mark in thick real-time glass, floating over a
 * smoked-glass plinth in a dark studio, bending the backlight strips and a
 * huge etched HARK behind it.
 *
 *   0.00–0.10  INTRO   front-on, right of centre (top on portrait); float,
 *                      slow sway, a light sweep every ~7 s; manifesto copy.
 *                      After the loader: the mark resolves out of frost —
 *                      emerald first, then the loops catch the light, then
 *                      the plinth pool blooms (time-based, ~1.6 s).
 *   0.10–0.55  LENS    the camera pushes in and orbits 120° while the mark
 *                      comes apart in depth (loop A forward, loop B back, the
 *                      core between) and re-seats; the strips slide behind it.
 *   0.55–0.93  PAYOFF  the mark turns back to meet the camera; tagline + CTAs.
 *   0.93–1.00  OUT     the camera drifts into the emerald core as the pane cut
 *                      begins.
 *
 * Every pose is derived from `local` (screenshots jump anywhere); frame.time
 * only drives idle float, sway and the light sweep.
 */

const ORBIT = THREE.MathUtils.degToRad(120)

/** smootherstep on a segment */
const sm = (x: number, a: number, b: number) => {
  const t = segment(x, a, b)
  return t * t * t * (t * (t * 6 - 15) + 10)
}
/** long, settling ease-out (≈ cubic-bezier(0.16, 1, 0.3, 1)) */
const outQuart = (t: number) => 1 - Math.pow(1 - clamp(t), 4)

interface Shot {
  /** where the mark's centre sits on screen (NDC) */
  sx: number
  sy: number
  /** mark height as a fraction of the viewport height / max width fraction */
  hf: number
  wf: number
  /** camera elevation (radians) */
  elev: number
  fov: number
  /** light-field spread */
  spread: number
  /** how far the satellites sit from the mark (x) */
  sats: number
  /** how high the mark lifts off the plinth */
  lift: number
}

const LAND: Record<'intro' | 'lens' | 'pay' | 'out', Shot> = {
  intro: { sx: 0.27, sy: 0.1, hf: 0.42, wf: 0.3, elev: 0.2, fov: 34, spread: 1.0, sats: 1, lift: 0 },
  lens: { sx: 0.0, sy: 0.06, hf: 0.52, wf: 0.5, elev: 0.1, fov: 34, spread: 1.12, sats: 1.1, lift: 0.45 },
  pay: { sx: 0.4, sy: 0.08, hf: 0.46, wf: 0.32, elev: 0.17, fov: 34, spread: 1.05, sats: 0.8, lift: 0 },
  out: { sx: 0.05, sy: 0.02, hf: 1.9, wf: 1.9, elev: 0.06, fov: 30, spread: 1.6, sats: 0.8, lift: 0 },
}
const PORT: Record<'intro' | 'lens' | 'pay' | 'out', Shot> = {
  intro: { sx: 0.0, sy: 0.3, hf: 0.3, wf: 0.66, elev: 0.2, fov: 38, spread: 0.85, sats: 0.62, lift: 0 },
  lens: { sx: 0.0, sy: 0.12, hf: 0.3, wf: 0.66, elev: 0.1, fov: 38, spread: 0.95, sats: 0.7, lift: 0.4 },
  pay: { sx: 0.0, sy: 0.33, hf: 0.29, wf: 0.64, elev: 0.17, fov: 38, spread: 0.85, sats: 0.62, lift: 0 },
  out: { sx: 0.0, sy: 0.2, hf: 1.6, wf: 1.9, elev: 0.06, fov: 34, spread: 1.4, sats: 0.62, lift: 0 },
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let set: HeroSet
  let reduced = false
  let mobile = false

  // DOM
  let intro: HTMLElement
  let payoff: HTMLElement
  let payoffInner: HTMLElement
  let title: HTMLElement
  const callouts: Callout[] = []
  // the exploded parts the callouts point at, and their resting centres (filled in init)
  const parts: THREE.Object3D[] = []
  const centres: THREE.Vector3[] = []

  // the copy's text boxes in NDC (right, top, bottom; intro then payoff), measured on
  // resize / once the font is in: on landscape the etched word keeps clear of them
  const MAXB = 48
  const boxes = new Float32Array(MAXB * 3 * 2)
  let nIntro = 0
  let nPay = 0
  let copyW = -1
  let copyH = -1
  let copyFonts = false
  let fontsIn = false
  const range = document.createRange()
  // every run of text, trimmed from its font box to roughly its glyphs (cap height to
  // descender), plus the buttons
  const collect = (root: HTMLElement, off: number, w: number, h: number) => {
    let n = 0
    const push = (r: DOMRect, inTop: number, inBottom: number) => {
      if (n >= MAXB || r.width < 1 || r.height < 1) return
      const o = (off + n++) * 3
      boxes[o] = (r.right / w) * 2 - 1
      boxes[o + 1] = 1 - ((r.top + r.height * inTop) / h) * 2
      boxes[o + 2] = 1 - ((r.bottom - r.height * inBottom) / h) * 2
    }
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (!t.textContent?.trim()) continue
      range.selectNodeContents(t)
      for (const r of range.getClientRects()) push(r, 0.16, 0.1)
    }
    for (const b of root.querySelectorAll('.hud-btn')) push(b.getBoundingClientRect(), 0, 0)
    return n
  }
  const measureCopy = (w: number, h: number) => {
    if (w === copyW && h === copyH && fontsIn === copyFonts) return
    copyW = w
    copyH = h
    copyFonts = fontsIn
    nIntro = collect(intro, 0, Math.max(1, w), Math.max(1, h))
    nPay = collect(payoffInner, MAXB, Math.max(1, w), Math.max(1, h))
  }
  /** the copy's right edge (plus a gap) beside the band y0..y1, blended intro → payoff */
  let payMix = 0
  let gap = 0
  let padY = 0
  let rampY = 0
  const edgeAt = (y0: number, y1: number) =>
    lerp(copyEdge(0, nIntro, y0, y1, padY, rampY), copyEdge(MAXB, nPay, y0, y1, padY, rampY), payMix) + gap
  /**
   * Project a rig-space point (rig turned by `ra` about y) with this frame's camera
   * (pos / tmpF / tmpR / tmpU): NDC x/y, view depth, and NDC x per unit of rig x.
   */
  const pr = { x: 0, y: 0, depth: 1, gx: 1 }
  const project = (x: number, y: number, z: number, ra: number, tanV: number, aspect: number) => {
    const c = Math.cos(ra)
    const s = Math.sin(ra)
    tmpW.set(x * c + z * s, y, -x * s + z * c).sub(pos)
    pr.depth = Math.max(0.1, tmpW.dot(tmpF))
    pr.x = tmpW.dot(tmpR) / (pr.depth * tanV * aspect)
    pr.y = tmpW.dot(tmpU) / (pr.depth * tanV)
    pr.gx = Math.max(0.2, c * tmpR.x - s * tmpR.z) / (pr.depth * tanV * aspect)
    return pr
  }
  /**
   * Right edge (NDC) of the copy lines that share the band y0..y1 (NDC, y up), padded by
   * `pad` (NDC). A line counts in proportion to how far it reaches into the padded band
   * (over `ramp`), so the edge never jumps as the band slides past a line.
   */
  const copyEdge = (off: number, n: number, y0: number, y1: number, pad: number, ramp: number) => {
    let e = -1.6
    for (let i = 0; i < n; i++) {
      const o = (off + i) * 3
      const into = Math.min(y1 + pad, boxes[o + 1]) - Math.max(y0 - pad, boxes[o + 2])
      if (into > 0) e = Math.max(e, lerp(-1.6, boxes[o], smoothstep(0, ramp, into)))
    }
    return e
  }

  // reveal clock (performance time, seconds)
  let revealAt = -1
  let initAt = 0
  const now = () => performance.now() / 1000

  // per-frame pose, computed in update(), written in camera()
  const pos = new THREE.Vector3()
  const tgt = new THREE.Vector3()
  let fov = 34
  const tmpF = new THREE.Vector3()
  const tmpR = new THREE.Vector3()
  const tmpU = new THREE.Vector3()
  const UP = new THREE.Vector3(0, 1, 0)
  const tmpW = new THREE.Vector3()
  const lensMix = new THREE.Color()
  const irisC = new THREE.Color(G.iris)

  /** blend the four shots for this local */
  const shotAt = (local: number, portrait: boolean, out: Shot) => {
    const S = portrait ? PORT : LAND
    const w1 = sm(local, 0.07, 0.3)
    const w2 = sm(local, 0.43, 0.64)
    const w3 = Math.pow(segment(local, 0.925, 1), 1.6)
    for (const k of Object.keys(out) as (keyof Shot)[]) {
      out[k] = lerp(lerp(lerp(S.intro[k], S.lens[k], w1), S.pay[k], w2), S.out[k], w3)
    }
    return out
  }
  const shot: Shot = { ...LAND.intro }

  return {
    id: 'hero',
    group,
    anchors: [0.8],

    async init(ctx: ChapterContext) {
      reduced = ctx.reducedMotion
      mobile = ctx.mobile
      initAt = now()

      const mark = buildMark(mobile)
      await nextFrame()
      const stage = buildStage(mobile)
      set = { ...mark, ...stage }
      for (const s of set.sats) s.rot = s.mesh.rotation.clone()
      parts.push(set.logo.loopA, set.logo.core, set.logo.loopB)
      centres.push(set.centres.loopA, set.centres.core, set.centres.loopB)
      group.add(set.pivot, set.plinth, set.poolUnder, set.poolTop, set.rig)

      // ---- DOM
      intro = el('div', 'hg-intro', undefined, ctx.stage)
      el('p', 'hud-eyebrow', MICROCOPY.signalEyebrow, intro)
      el('p', 'hud-body hg-manifesto', BRAND.manifesto, intro)
      const hint = el('p', 'hud-label hg-hint', undefined, intro)
      el('span', 'hg-hint-line', undefined, hint)
      el('span', '', MICROCOPY.scrollHint, hint)

      payoff = el('div', 'hg-payoff', undefined, ctx.stage)
      const inner = (payoffInner = el('div', 'hg-payoff-inner', undefined, payoff))
      el('p', 'hud-label hg-locale', BRAND.locale, inner)
      title = rise(el('h1', 'hud-title hg-title', undefined, inner), 'Make the internet <em>listen.</em>')
      const ctas = el('div', 'hg-ctas', undefined, inner)
      const see = el('button', 'hud-btn', 'See the work', ctas)
      see.type = 'button'
      see.addEventListener('click', () => window.__hark?.land('work'))
      const start = el('a', 'hud-btn hud-btn--ghost', 'Start a project', ctas)
      start.href = '#contact'
      start.addEventListener('click', e => {
        if (!window.__hark) return
        e.preventDefault()
        window.__hark.land('contact')
      })

      // the exploded view names its parts
      const labels = ['Glass loop · 01', 'Signal core', 'Glass loop · 02']
      // loop 02's label drops below-right of its loop, so it never lands on the core
      const sides: ('left' | 'right')[] = ['right', 'left', 'right']
      const dy = [-46, 54, 64]
      for (let i = 0; i < 3; i++) {
        const c = new Callout(ctx.stage, { side: sides[i], offset: { x: mobile ? 34 : 70, y: dy[i] } })
        c.label.textContent = labels[i]
        c.root.classList.add('hg-callout')
        callouts.push(c)
      }

      document.fonts?.ready
        .then(() => {
          fontsIn = true
        })
        .catch(() => {})

      const onReveal = () => {
        if (revealAt < 0) revealAt = now()
      }
      if (document.documentElement.dataset.ready === '1') onReveal()
      else window.addEventListener('hark:reveal', onReveal, { once: true })
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      if (!set) return
      const t = frame.time
      // matches the stylesheet's (max-aspect-ratio: 1/1) portrait layout
      const portrait = frame.width <= frame.height
      const aspect = frame.width / Math.max(1, frame.height)
      const calm = reduced ? 0.25 : 1

      // ---- reveal (time-based): frost clears, emerald ignites, loops catch light, pool blooms
      const clock = now()
      if (revealAt < 0 && (document.documentElement.dataset.ready === '1' || clock - initAt > 20)) revealAt = clock
      const since = revealAt < 0 ? 0 : clock - revealAt
      const rk = reduced ? 3 : 1 // reduced motion: a quick, plain fade
      const rFrost = reduced ? 0 : 1 - sm(since, 0.05, 1.25)
      const rCore = sm(since * rk, 0.0, 0.55)
      const rLoops = sm(since * rk, 0.3, 1.3)
      const rPool = sm(since * rk, 0.6, 1.65)
      const rSweep = reduced ? 0 : (1 - outQuart(segment(since, 0.25, 1.9))) * 1.1

      // ---- camera shot + orbit
      shotAt(local, portrait, shot)
      const orbitP = sm(local, 0.08, 0.56)
      const theta = orbitP * ORBIT
      const tanV = Math.tan(THREE.MathUtils.degToRad(shot.fov / 2))
      const size = MARK_S * 1.02
      // exploded view: 0 at rest, 1 fully apart
      const ex = sm(local, 0.12, 0.3) * (1 - sm(local, 0.4, 0.53))
      // on portrait the fit is width-bound, and the exploded, turned stack (loops at ±z,
      // fanned, seen at a ~55° three-quarter) is far wider than the assembled mark
      const d = Math.max(size / (shot.hf * 2 * tanV), size / (shot.wf * 2 * tanV * aspect)) * (portrait ? 1 + 0.3 * ex : 1)
      tgt.set(0, MARK_Y + shot.lift, 0)
      const ce = Math.cos(shot.elev)
      pos.set(Math.sin(theta) * ce, Math.sin(shot.elev), Math.cos(theta) * ce).multiplyScalar(d).add(tgt)
      tmpF.subVectors(tgt, pos).normalize()
      tmpR.crossVectors(tmpF, UP).normalize()
      tmpU.crossVectors(tmpR, tmpF)
      const shiftR = -shot.sx * d * tanV * aspect
      const shiftU = -shot.sy * d * tanV
      pos.addScaledVector(tmpR, shiftR).addScaledVector(tmpU, shiftU)
      tgt.addScaledVector(tmpR, shiftR).addScaledVector(tmpU, shiftU)
      fov = shot.fov

      // ---- the mark: float, sway, turn to meet the camera, exploded view
      const lensW = smoothstep(0.06, 0.2, local) * (1 - smoothstep(0.5, 0.66, local))
      const sway = (1 - lensW * 0.8) * THREE.MathUtils.degToRad(10) * Math.sin(t * 0.55 * calm)
      // the mark turns to follow the camera, so the view peaks at a ~55° three-quarter
      // (thickness, bevels, dispersion) and never shows the flat side of the slab
      const face = sm(local, 0.22, 0.6) * ORBIT
      set.pivot.rotation.set(0.04 * Math.sin(t * 0.37 * calm) * (1 - lensW), face + sway, 0.025 * Math.sin(t * 0.29 * calm))
      set.pivot.position.y = MARK_Y + shot.lift + 0.046 * Math.sin(t * 0.9 * calm)
      const { loopA, loopB, core } = set.logo
      // exploded view: loop A forward, loop B back, the core between; the loops fan a little
      loopA.position.z = 0.38 * ex
      loopB.position.z = -0.38 * ex
      loopA.rotation.set(0, 0.2 * ex, 0.06 * ex)
      loopB.rotation.set(0, -0.2 * ex, -0.06 * ex)
      core.position.z = 0.02 * ex
      core.rotation.z = 0.3 * ex
      const coreScale = 1 + 0.12 * ex
      core.scale.setScalar(coreScale)

      // ---- where the copy is (landscape): the etch and the satellites keep clear of it
      payMix = sm(local, 0.43, 0.64)
      const present = portrait ? 0 : Math.max(1 - sm(local, 0.06, 0.2), sm(local, 0.45, 0.62))
      if (present > 0) measureCopy(frame.width, frame.height)
      gap = 80 / Math.max(1, frame.width) // 40px beside the copy, in NDC
      padY = 24 / Math.max(1, frame.height) // and 12px above / below its glyphs
      rampY = 8 / Math.max(1, frame.height)

      // ---- the rig (backdrop + satellites) follows the orbit with a lag: parallax
      const lag = Math.sin(Math.PI * orbitP)
      const ra = theta - 0.5 * lag
      set.rig.rotation.y = ra
      for (const s of set.sats) {
        const p = s.mesh.position.copy(s.base)
        p.x *= shot.sats
        p.y += s.bob * Math.sin(t * 0.6 * calm + s.phase)
        p.x += 0.03 * Math.sin(t * 0.4 * calm + s.phase * 2)
        s.mesh.rotation.set(s.rot.x + s.spin.x * t * calm, s.rot.y + s.spin.y * t * calm, s.rot.z + s.spin.z * t * calm)
        // a satellite on the copy side slides right until it clears the copy lines beside it
        if (present > 0 && s.base.x < 0) {
          const q = project(p.x, p.y, p.z, ra, tanV, aspect)
          const rx = s.radius / (q.depth * tanV * aspect)
          const ry = s.radius / (q.depth * tanV)
          const over = edgeAt(q.y - ry, q.y + ry) - (q.x - rx)
          if (over > 0) p.x += (over * present) / q.gx
        }
      }

      // ---- materials: reveal + light
      // the emerald is the accent: a crisp lit gem, not a glare that floods the loops
      set.coreMat.emissiveIntensity = 0.9 * rCore
      set.logo.glow.intensity = 0.7 * rCore
      set.loopMat.envMapIntensity = lerp(0.15, 1.5, rLoops)
      set.rimMat.uniforms.uStrength.value = 0.34 * rLoops
      set.plinthMat.envMapIntensity = lerp(0.3, 1.25, rLoops)
      const pu = set.poolUnder.material as THREE.ShaderMaterial
      pu.uniforms.uStrength.value = 0.3 * rPool
      pu.uniforms.uTime.value = t * 0.35 * calm
      const pt = set.poolTop.material as THREE.ShaderMaterial
      pt.uniforms.uStrength.value = 0.2 * rCore * (1 - 0.6 * ex)
      pt.uniforms.uTime.value = t * 0.3 * calm
      set.backdropMat.color.set(G.mist).multiplyScalar(0.38 * lerp(0.35, 1, rLoops))

      // ---- the etched word: centred behind the mark at rest (the loops bend its middle),
      // but on landscape never behind a line of copy: as the copy comes in it slides right
      // and, if it still can't fit, shrinks between the copy and the frame edge
      const bp = set.backdrop.geometry.parameters
      // the etch's centre (rig x = 0), projected with this frame's camera
      const { x: c0, y: cy, gx } = project(0, set.backdrop.position.y, set.backdrop.position.z, ra, tanV, aspect)
      const w1 = 0.5 * bp.width * gx // NDC half-width at scale 1
      // free: centred on the mark in the rest poses; during the orbit the rig's lag swings it
      const xFree = shot.sx * (d + 5.5 * ce) * tanV * aspect + shiftR
      const cFree = c0 + xFree * gx
      let bk = 1
      let bc = cFree
      if (present > 0) {
        // the letters run from 0.38 above the plane's centre (cap height) to 0.36 below (baseline)
        const ph = bp.height / (pr.depth * tanV)
        const E = edgeAt(cy - 0.36 * ph, cy + 0.38 * ph)
        const R = Math.max(0.97, cFree + w1) // as far right as it would naturally run
        let kc = 1
        let cc = Math.max(cFree, E + w1)
        if (E + 2 * w1 > R) {
          const w = Math.max(0.55 * w1, (R - E) / 2)
          kc = w / w1
          cc = E + w
        }
        bk = lerp(1, kc, present)
        bc = lerp(cFree, cc, present)
      }
      set.backdrop.scale.setScalar(bk)
      set.backdrop.position.x = xFree + (bc - cFree) / gx

      // ---- world: dark studio, strips behind the mark, pools gathered on it
      const wp = ctx.world.params
      // a small colour journey through the lens: the pool behind the glass cools to iris.
      // Mint/aqua/iris pools on ink: the emerald stays the core's accent, not a flood.
      wp.a = lensMix.set(G.mint).lerp(irisC, 0.6 * lensW)
      wp.b = G.aqua
      wp.c = G.iris
      wp.d = G.rose
      wp.base = '#04060b'
      wp.glow = lerp(0.2, 0.45, rLoops) * (1 - 0.3 * lensW) * (portrait ? 0.85 : 1)
      wp.flow = reduced ? 0.3 : 0.75
      wp.strips = lerp(0.3, 1.25, rLoops) * (1 + 0.15 * lensW)
      wp.stripColor = '#eafff5'
      // strips: at rest a short softbox glow either side of the mark (the centre strip is
      // off, so no line runs through the emerald); in the lens beat they run tall and all
      // three slide behind the glass. After the loader they draw in from full height as
      // the frost clears (not under reduced motion).
      const drawIn = reduced ? 0 : 1 - rPool
      wp.stripHeight = lerp(lerp(0.55, 0.95, lensW), 1, drawIn * (1 - lensW))
      wp.stripMask.set(1, lensW, 1)
      wp.spread = shot.spread
      // the field's own heading drift (World.ts) — cancel it so focus sits behind the mark
      const yaw = Math.atan2(tmpF.x, -tmpF.z)
      const pitch = Math.asin(clamp(tmpF.y, -1, 1))
      const slide = 0.26 * Math.sin(Math.PI * segment(local, 0.1, 0.55)) // strips slide behind the glass
      wp.focus.set(shot.sx * aspect + Math.sin(yaw) * 0.35 + slide * shot.spread, shot.sy + pitch * 0.3)
      // a light sweep every ~7 s: glide across, rest, glide back (calm under reduced motion)
      let sweep = 0
      if (!reduced) {
        const cyc = t / 7
        const ph = cyc - Math.floor(cyc)
        const dir = Math.floor(cyc) % 2 === 0 ? 1 : -1
        sweep = 0.42 * dir * (sm(ph, 0.0, 0.36) * 2 - 1)
      }
      wp.envTurn = theta - 0.55 * lag + sweep + rSweep
      wp.env = lerp(0.35, 1.2, rLoops)
      wp.key = 1.7
      wp.keyDir.set(-0.55, 0.75, 0.55)
      wp.fill = 0.3

      // ---- post: bloom on the emerald, frost for the reveal and the final dive
      const pp = ctx.post.params
      pp.bloomStrength = 0.4
      pp.bloomRadius = 0.5
      pp.bloomThreshold = 1.05
      pp.vignette = 0.36 + 0.1 * lensW
      pp.frost = Math.max(rFrost * 0.75, reduced ? 0 : 0.22 * smoothstep(0.955, 1, local))

      // ---- DOM
      reveal(intro, 1 - smoothstep(0.065, 0.105, local))
      intro.classList.toggle('is-in', revealAt >= 0 && since > (reduced ? 0 : 0.5))
      reveal(payoff, smoothstep(0.585, 0.655, local) * (1 - smoothstep(0.925, 0.96, local)), 0)
      setRise(title, local > 0.6 && local < 0.945)

      // callouts: name the parts while the stack is apart (not on phones held upright, nor on
      // short landscapes, where the parts sit too close for three labels)
      const roomy = !(mobile && portrait) && frame.height >= 480
      const cv = roomy ? smoothstep(0.2, 0.25, local) * (1 - smoothstep(0.36, 0.4, local)) : 0
      if (cv > 0) set.pivot.updateMatrixWorld(true)
      for (let i = 0; i < 3; i++) {
        if (cv > 0) parts[i].localToWorld(tmpW.copy(centres[i]))
        callouts[i].update(tmpW, ctx.camera, frame.width, frame.height, cv)
      }
    },

    camera(_local: number, _frame: Frame, out: CameraPose) {
      out.position.copy(pos)
      out.target.copy(tgt)
      out.fov = fov
      out.roll = 0
      out.parallax = 0.28
    },
  }
}
