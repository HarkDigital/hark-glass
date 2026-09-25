import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, damp, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { G } from '../../kit/glass'
import { Hud, type HudMetrics } from './hud'
import { APOTHEM, FACET_COLORS, N, OUTER_R, PLINTH_R, PLINTH_Y, STEP, TILE_D, TILE_H, buildCrystal, type Crystal } from './crystal'
import './services.css'

/*
 * SERVICES — "Facets".
 *
 * A gem of eleven thick glass tiles on a turntable; each tile carries its
 * service glyph as a thin line of light inside the glass. Scroll turns the
 * crystal so the active facet faces the camera, a studio highlight sweeps
 * across it, its glyph brightens while the others dim (and their glass goes
 * satin: a focus pull), and a caustic pool of the facet's colour falls on
 * the turntable. The frosted card names the facet at rest.
 *
 *   0.00–0.10  intro: the tiles assemble out of frost, from depth, and seat;
 *              "Eleven ways to be heard." (the nav landing, 0.08, is settled)
 *   0.10–0.90  eleven facets (~0.073 each): turn → sweep → settle → hold
 *   0.90–1.00  the crystal spins up; the backlight flares into a spectrum
 *              as the frosted pane cut arrives
 *
 * Everything derives from `local`; frame.time only drives idle float/sway.
 * Two things are smoothed over time so fast scrolling can't strobe
 * (WCAG 2.3.1): each facet's light is damped toward its target, and the
 * per-facet studio sweep, caustic dip and breathe fade out with scroll speed,
 * so a fast scrub merges into one steady light.
 *
 * Backlight: two short softbox strips straddle the facet in focus, on its
 * joints (phones: out by the front three's outer joints), so the glass edges
 * carry the light and the glyph sits on clean dark glass.
 */

const A = 0.1
const B = 0.9
const SPAN = (B - A) / N
/** half-width (in beats) of each turn, centred on the boundary between two facets */
const TURN = 0.27
const CARD_OUT = 0.915
const INTRO_IN = 0.045
const INTRO_OUT = 0.1
const ENV_REST = 0.6
const ANCHORS = Array.from({ length: N }, (_, i) => A + SPAN * (i + 0.55))

/** a long, front-loaded glide with a soft start and a settled finish */
const glide = (t: number) => {
  const x = Math.pow(clamp(t), 0.72)
  return x * x * (3 - 2 * x)
}
/** 0 → 1 → 0 bump over x ∈ [-1, 1] */
const bump = (x: number) => {
  const a = clamp(1 - x * x)
  return a * a
}
/** signed shortest distance between two facet indices */
const wrapd = (d: number) => {
  let x = d % N
  if (x > N / 2) x -= N
  if (x < -N / 2) x += N
  return x
}

/** Continuous facet index (0..N-1): holds on each facet mid-beat, turns across the boundaries. */
function facetAt(local: number) {
  const u = (local - A) / SPAN
  let f = 0
  let turning = 0
  for (let j = 1; j < N; j++) {
    f += glide((u - (j - TURN)) / (2 * TURN))
    turning = Math.max(turning, bump((u - j) / TURN))
  }
  return { f, u, turning }
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let crystal: Crystal
  let hud: Hud
  let canvas: HTMLCanvasElement | null = null
  let active = false
  let mobile = false

  const colA = new THREE.Color()
  const white = new THREE.Color(1, 1, 1)
  const tmp = new THREE.Color()
  const glyphCols = FACET_COLORS.map(c => new THREE.Color(c))
  // the light the facet throws into the studio and onto the turntable: emerald stays the
  // accent (glyph, chip, rim), so emerald facets pour mint, not a green flood
  const poolCols = FACET_COLORS.map(c => new THREE.Color(c === G.signal ? G.mint : c))
  const iris = new THREE.Color(G.iris)

  // the pose is computed in update() (so the world focus can sit behind the crystal) and copied in camera()
  const pose = { pos: new THREE.Vector3(0, 0.6, 9), target: new THREE.Vector3(), fov: 30, cx: 0.3, cy: 0 }
  const dir = new THREE.Vector3()
  const raycaster = new THREE.Raycaster()
  const ndc = new THREE.Vector2()
  let lastHoverX = 9
  let lastHoverY = 9
  let lastLocal = 0

  // time-smoothed light (see the header): per-facet focus, speed calm, the colour of the moment
  const lit = new Float32Array(N)
  let calm = 1
  let snap = true
  const mood = new THREE.Color()

  // the facet in focus, at rest, in world-field units (NDC·aspect): joints left/right of it,
  // the outer joints of the front three, its vertical centre and half-height (strip placement)
  const tileP = { xl: 0, xr: 0, xl3: 0, xr3: 0, yc: 0, hh: 0.5 }
  const JOINT_R = (APOTHEM + TILE_D / 2) / Math.cos(STEP / 2)
  const jointPts = [-0.5, 0.5, -1.5, 1.5].map(k => new THREE.Vector3(Math.sin(k * STEP) * JOINT_R, 0, Math.cos(k * STEP) * JOINT_R))
  const tileTop = new THREE.Vector3(0, TILE_H / 2, APOTHEM + TILE_D / 2)
  const tileBot = new THREE.Vector3(0, -TILE_H / 2, APOTHEM + TILE_D / 2)

  // framing: the seated crystal's silhouette (tile tops + turntable rim), projected
  const bounds: THREE.Vector3[] = []
  for (let k = 0; k < 24; k++) {
    const a = (k / 24) * Math.PI * 2
    bounds.push(new THREE.Vector3(Math.sin(a) * OUTER_R, TILE_H / 2 + 0.02, Math.cos(a) * OUTER_R))
    bounds.push(new THREE.Vector3(Math.sin(a) * (PLINTH_R + 0.04), PLINTH_Y - 0.07, Math.cos(a) * (PLINTH_R + 0.04)))
  }
  const probe = new THREE.PerspectiveCamera()
  const pv = new THREE.Vector3()

  function aim(d: number, elev: number, oy: number, ax: number, ay: number, tv: number, th: number) {
    pose.pos.set(0, oy + d * Math.sin(elev), d * Math.cos(elev))
    // aim off-centre so the crystal lands at (ax, ay) on screen
    const s = ax * th * d
    const v = ay * tv * d
    pose.target.set(-s, oy - v * Math.cos(elev), v * Math.sin(elev))
  }

  function computePose(local: number, frame: Frame, m: HudMetrics) {
    const W = Math.max(1, frame.width)
    const H = Math.max(1, frame.height)
    const aspect = W / H
    const portrait = H > W
    const fov = portrait ? 36 : 30
    const tv = Math.tan(THREE.MathUtils.degToRad(fov / 2))
    const th = tv * aspect
    const gutter = m.valid ? m.gutter : 24
    const safeTop = m.valid ? m.safeTop : H * 0.11
    const safeBottom = m.valid ? m.safeBottom : H * 0.11
    let x0: number, x1: number, y0: number, y1: number
    if (portrait) {
      x0 = gutter
      x1 = W - gutter
      y0 = safeTop + 4
      y1 = (m.valid ? m.cardTop : H * 0.55) - 14
    } else {
      x0 = (m.valid ? m.colRight : W * 0.36) + 28
      x1 = W - gutter * 1.2
      y0 = safeTop + 6
      y1 = H - safeBottom - 6
    }
    // the free region in NDC, and the size the crystal should fill inside it
    const fill = portrait ? 0.96 : 0.9
    const cx = (x0 + x1) / W - 1
    const cy = 1 - (y0 + y1) / H
    const hw = Math.max(0.15, ((x1 - x0) / W) * fill)
    const hh = Math.max(0.12, ((y1 - y0) / H) * fill)
    const elev = portrait ? 0.08 : 0.095
    const oy = (TILE_H / 2 + PLINTH_Y) / 2

    // first guess, then correct twice against the projected silhouette
    let d = Math.max((2 * OUTER_R) / (2 * th * hw), (TILE_H + 0.4) / (2 * tv * hh))
    let ax = cx
    let ay = cy
    probe.fov = fov
    probe.aspect = aspect
    probe.updateProjectionMatrix()
    for (let it = 0; it < 3; it++) {
      aim(d, elev, oy, ax, ay, tv, th)
      probe.position.copy(pose.pos)
      probe.lookAt(pose.target)
      probe.updateMatrixWorld()
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      for (const b of bounds) {
        pv.copy(b).project(probe)
        if (pv.x < minX) minX = pv.x
        if (pv.x > maxX) maxX = pv.x
        if (pv.y < minY) minY = pv.y
        if (pv.y > maxY) maxY = pv.y
      }
      if (!Number.isFinite(minX + maxX + minY + maxY)) break
      const k = Math.max((maxX - minX) / (2 * hw), (maxY - minY) / (2 * hh))
      ax -= (minX + maxX) / 2 - cx
      ay -= (minY + maxY) / 2 - cy
      d *= clamp(k, 0.5, 2)
    }
    // intro: settle in from a touch further; outro: a slow push as it spins up
    const out = smoothstep(0.9, 1, local)
    d *= 1 + 0.08 * (1 - glide(local / 0.08)) - 0.06 * out
    aim(d, elev, oy, ax, ay, tv, th)
    pose.fov = fov
    pose.cx = ax
    pose.cy = ay

    // where the facet in focus sits on screen (for the backlight strips)
    probe.position.copy(pose.pos)
    probe.lookAt(pose.target)
    probe.updateMatrixWorld()
    const xl = pv.copy(jointPts[0]).project(probe).x * aspect
    const xr = pv.copy(jointPts[1]).project(probe).x * aspect
    const xl3 = pv.copy(jointPts[2]).project(probe).x * aspect
    const xr3 = pv.copy(jointPts[3]).project(probe).x * aspect
    const yT = pv.copy(tileTop).project(probe).y
    const yB = pv.copy(tileBot).project(probe).y
    if (Number.isFinite(xl + xr + xl3 + xr3 + yT + yB) && xr > xl && yT > yB) {
      tileP.xl = xl
      tileP.xr = xr
      tileP.xl3 = xl3
      tileP.xr3 = xr3
      tileP.yc = (yT + yB) / 2
      tileP.hh = Math.max(0.05, (yT - yB) / 2)
    }
  }

  return {
    id: 'services',
    group,
    anchors: ANCHORS,

    async init(ctx: ChapterContext) {
      mobile = ctx.mobile
      crystal = buildCrystal(ctx.mobile)
      group.add(crystal.stand, crystal.backdrop)
      await nextFrame()
      hud = new Hud(ctx.stage, FACET_COLORS, k => window.__hark?.land('services', true, ANCHORS[k]))

      // click a facet to land on it (click, not pointerdown: touch scrolls must not jump)
      canvas = ctx.renderer.domElement
      canvas.addEventListener('click', e => {
        if (!active || !canvas || lastLocal < A - 0.03 || lastLocal > CARD_OUT) return
        const r = canvas.getBoundingClientRect()
        ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
        const k = pick(ctx)
        if (k >= 0) window.__hark?.land('services', true, ANCHORS[k])
      })
    },

    onEnter() {
      active = true
      snap = true
    },
    onLeave() {
      active = false
      if (canvas) canvas.style.cursor = ''
    },

    update(local, frame, ctx) {
      const w = ctx.world.params
      const post = ctx.post.params
      const rm = frame.reducedMotion
      const t = frame.time * (rm ? 0.2 : 1)
      const dt = frame.dt
      // a teleport (nav jump, entering the chapter) lands settled; scrolling eases
      if (Math.abs(local - lastLocal) > 0.04) snap = true
      lastLocal = local
      const m = hud.metrics()
      computePose(local, frame, m)

      const { f, u, turning } = facetAt(local)
      const introMix = 1 - smoothstep(0.086, 0.112, local)
      const out = smoothstep(0.9, 0.97, local)
      const outSpin = clamp((local - 0.9) / 0.1)
      // speed calm: 1 at reading pace, 0 when scrubbing ≳ 4 facets/s (drops fast, recovers gently)
      const calmV = 1 - smoothstep(0.5, 1.2, Math.abs(frame.velocity))
      calm = snap ? calmV : damp(calm, calmV, calmV < calm ? 10 : 2.5, dt)

      // ---------- the turntable
      const standIn = glide(local / 0.075)
      const introTurn = (1 - standIn) * 0.85
      const spin = outSpin * outSpin * (rm ? 0.9 : 2.6)
      const sway = Math.sin(t * 0.3) * (rm ? 0.008 : 0.03)
      const ringY = -f * STEP + introTurn - spin + sway
      crystal.ring.rotation.y = ringY
      crystal.stand.position.set(0, Math.sin(t * 0.55) * (rm ? 0.008 : 0.03), -3.2 * (1 - standIn))
      crystal.stand.scale.setScalar(0.9 + 0.1 * standIn)

      // ---------- the facets
      const breathe = turning * calm * 0.09 * (rm ? 0.4 : 1)
      for (const tile of crystal.tiles) {
        const i = tile.index
        const dFront = Math.min(i, N - i) // 0 front … 5 back
        const e = glide((local - (5 - dFront) * 0.0058) / 0.046)
        // the facet's light follows the turn with a short lag, so a fast scrub merges into a steady glow
        const target = Math.max(0, 1 - Math.abs(wrapd(i - f)))
        lit[i] = snap ? target : damp(lit[i], target, 5, dt)
        const act = lit[i]
        const focus = act * (1 - introMix) * (1 - out)
        const explode = (1 - e) * 1.9
        tile.holder.position.set(0, (i % 2 ? 0.45 : -0.45) * (1 - e), APOTHEM + explode + breathe + 0.07 * focus)
        tile.holder.rotation.y = (1 - e) * (i % 2 ? 0.35 : -0.35)

        // glass: clear on the facet in focus, satin on the rest; frosted while assembling
        const rough = lerp(lerp(0.12, 0.008, act), 0.03, Math.max(introMix, out))
        tile.mat.roughness = rough + 0.45 * (1 - e)
        tile.mat.envMapIntensity = 1.25 + 0.35 * focus

        // glyph: HDR light in the facet's colour when in focus, a dim etched line otherwise
        const itemB = lerp(0.3, mobile ? 1.7 : 3.4, act * act)
        const b = lerp(itemB, 1.05, Math.max(introMix, out * 0.85)) * (0.35 + 0.65 * e)
        tmp.copy(white).lerp(glyphCols[i], 0.55 + 0.25 * act)
        tile.plateMat.color.copy(tmp).multiplyScalar(b)
        if (tile.faceMat) tile.faceMat.color.copy(tmp).multiplyScalar(1.6 * focus * focus)

        // phones: tiles turned away are hidden behind the front ones anyway — skip them
        if (mobile) tile.holder.visible = Math.cos(tile.angle + ringY) > -0.4 || e < 0.98
      }

      // ---------- colour of the moment: blend between the two facets around f
      const i0 = Math.max(0, Math.min(N - 1, Math.floor(f)))
      const i1 = Math.min(N - 1, i0 + 1)
      colA.copy(poolCols[i0]).lerp(poolCols[i1], f - i0)
      if (snap) mood.copy(colA)
      else mood.lerp(colA, 1 - Math.exp(-4 * dt))
      snap = false

      // caustic pool + emerald rim
      const pool = crystal.poolMat.uniforms
      ;(pool.uColor.value as THREE.Color).copy(mood).lerp(white, out * 0.35)
      pool.uStrength.value = (0.22 + 0.36 * (1 - turning * calm)) * (0.3 + 0.7 * standIn) * (1 + 0.3 * out)
      pool.uTime.value = t
      crystal.rimMat.color.set(G.signal).multiplyScalar(0.5 + 0.7 * standIn + 0.5 * out)

      // backdrop lines → spectrum
      const bd = crystal.backdropMat.uniforms
      bd.uLines.value = (0.085 + 0.025 * introMix) * (1 - out * 0.6)
      bd.uSpectrum.value = out * out
      bd.uTime.value = t

      // ---------- world: pools and strips gather behind the crystal
      dir.copy(pose.target).sub(pose.pos).normalize()
      const yaw = Math.atan2(dir.x, -dir.z)
      const pitch = Math.asin(clamp(dir.y, -1, 1))
      const aspect = frame.width / Math.max(1, frame.height)
      // strips: the left and centre-right bars (field: focus − 0.34·spread and + 0.18·spread)
      // straddle the facet in focus, on its joints where the spread allows; phones, where the
      // tile is narrow, put them out behind the front three's outer joints. Spread also sizes
      // the pools, so it stays within a band that keeps the studio's colour where it was.
      const inner = (tileP.xr - tileP.xl) / 0.52
      const spread = clamp(inner >= 0.6 ? inner : (tileP.xr3 - tileP.xl3) / 0.52, 0.85, 1.15)
      const bandY = tileP.yc + 0.25 * tileP.hh
      w.focus.set((tileP.xl + tileP.xr) / 2 + 0.08 * spread + Math.sin(yaw) * 0.35, bandY + pitch * 0.3)
      w.spread = spread * (1 + 0.12 * out)
      // short: a glow behind the glass that fades before the plinth and the chrome; taller at the flare
      w.stripHeight = ((0.62 * tileP.hh) / spread) * (1 + 1.3 * out * out)
      w.stripMask.set(0.8, 1, 0.7 * out)
      w.a = out > 0.01 ? tmp.copy(mood).lerp(iris, out) : mood
      w.b = out > 0.5 ? G.rose : G.aqua
      w.c = G.iris
      w.d = out > 0.5 ? G.amber : G.rose
      w.glow = (mobile ? 0.66 : 0.78) + 0.1 * introMix + 0.45 * out
      w.strips = 0.62 + 0.38 * out
      w.stripColor = '#eafff5'
      w.env = 1.25
      // the light sweep: while a facet turns in, the studio swings away and back
      // (continuous across facets: sin(π·frac) is 0 at every rest), so the strip
      // highlights run across the glass as each tile arrives and every facet rests
      // under the same light. Static under reduced motion.
      // Scaled by the speed calm: scrubbing fast holds the studio still.
      const sweep = Math.sin(Math.PI * (f - Math.floor(f)))
      w.envTurn = rm ? ENV_REST : ENV_REST - 1.3 * sweep * calm - spin * 0.6
      w.keyDir.set(-0.55, 0.8, 0.5)
      w.key = 1.8
      w.fill = 0.3

      // ---------- post: assemble out of frost; a little more bloom and split at the flare
      post.frost = 0.45 * (1 - smoothstep(0.012, 0.068, local))
      post.bloomStrength = 0.5 + 0.28 * out
      post.bloomThreshold = 0.9
      post.aberration = 0.0012 + 0.0024 * out

      // ---------- copy
      const introOn = local >= INTRO_IN && local < INTRO_OUT
      const shown = local >= A && local < CARD_OUT ? Math.max(0, Math.min(N - 1, Math.floor(u))) : -1
      hud.update(introOn, shown, shown)

      // ---------- hover: a pointer over a facet (desktop)
      if (active && !mobile && canvas) {
        const px = frame.pointerRaw.x
        const py = frame.pointerRaw.y
        if (px !== lastHoverX || py !== lastHoverY) {
          lastHoverX = px
          lastHoverY = py
          ndc.set(px, py)
          const k = local > A - 0.03 && local < CARD_OUT ? pick(ctx) : -1
          canvas.style.cursor = k >= 0 ? 'pointer' : ''
        }
      }
    },

    camera(_local, frame, out: CameraPose) {
      out.position.copy(pose.pos)
      out.target.copy(pose.target)
      out.fov = pose.fov
      out.roll = 0
      out.parallax = frame.mobile ? 0 : 0.22
    },
  }

  /** facet under `ndc`, or -1 */
  function pick(ctx: ChapterContext): number {
    raycaster.setFromCamera(ndc, ctx.camera)
    const hits = raycaster.intersectObjects(
      crystal.tiles.filter(t => t.holder.visible).map(t => t.glass),
      false,
    )
    if (!hits.length) return -1
    const k = hits[0].object.userData.facet
    return typeof k === 'number' ? k : -1
  }
}
