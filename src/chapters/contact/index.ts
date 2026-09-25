import * as THREE from 'three'
import type { Chapter, ChapterContext } from '../../core/types'
import { reveal, setRise } from '../../core/dom'
import { clamp, damp, ease, lerp, smoothstep } from '../../core/math'
import { nextFrame } from '../../core/yield'
import { buildHud, measureHud, type Hud, type HudLayout } from './hud'
import { buildScene, type LensScene } from './scene'
import './contact.css'

/*
 * CONTACT · "Clear" — the final chapter.
 *
 * The Hark mark returns, perfectly clear and whole, on a slow turntable in the
 * free space beside the contact card. A big clear glass sphere drifts across
 * in front of it and — like a real ball lens — shows the mark FLIPPED and
 * magnified as it passes (the landing, 0.30, is that moment). Then the lens
 * glides on and back into depth to rest beside the mark, the mark turns
 * front-on, one last gentle light sweep slides the studio strips along its
 * outer bevels, and everything is still: the round mark, clear, front-on.
 *
 *   0.00–0.06  calm in-beat under the passing frosted pane: mark at 3/4, lens low
 *   0.05–0.17  focus pull (frost clears) — "Clear"; the card comes into focus
 *   0.06–0.30  the lens rises in front of the mark; a light sweep meets it
 *   0.30–0.40  the lens holds over the mark: flipped, magnified (landing)
 *   0.40–0.86  the lens drifts on and recedes to rest lower-right; the mark turns front-on
 *   0.73–0.87  the last light sweep; the rings send one slow pulse outward
 *   0.86–1.00  the final still
 *
 * Everything is derived from `local`; frame.time only adds idle float/sway
 * (which fades out for the final still) and a soft response of the emerald
 * core while the address has the pointer.
 */

const FOV = 30
const DIST = 10
const TAN = Math.tan(THREE.MathUtils.degToRad(FOV / 2))

/**
 * Lens path keys at curve t = 0, .25, .5, .75, 1. x/y are where the lens
 * APPEARS relative to the mark (in mark heights, as seen at the mark's depth;
 * perspective is undone in update), z is depth in rig units (+ = nearer).
 * t = .25 is the landing: the lens exactly over the mark.
 */
const PATH_LANDSCAPE: [number, number, number][] = [
  [-0.75, -1.2, 0.2],
  [0.0, 0.0, 1.2],
  [0.6, -0.1, 1.0],
  [1.1, -0.32, 0.1],
  [1.0, -0.4, -2.3],
]
const PATH_PORTRAIT: [number, number, number][] = [
  [-1.35, -0.3, 0.2],
  [0.0, 0.0, 1.2],
  [0.62, -0.06, 0.98],
  [1.12, -0.22, 0.1],
  [1.0, -0.28, -2.3],
]
/** the mark sits this far (mark heights) left of the art centre, leaving the lens room to rest */
const MARK_SHIFT = 0.3
/** the backlight strip's x behind the mark, in mark heights from its centre */
const STRIP_X = 0.2
/**
 * Where the studio rests for the final still (and the whole chapter under
 * reduced motion): the strips lie along the loops' outer bevels, so the mark
 * reads round and front-on. Clean from about -0.3 to 0.85.
 */
const TURN_END = 0.72

export default function create(): Chapter {
  const group = new THREE.Group()
  let hud: Hud
  let set: LensScene
  let lay: HudLayout | null = null
  let lastW = 0
  let lastH = 0
  let curveL: THREE.CatmullRomCurve3
  let curveP: THREE.CatmullRomCurve3
  const lensPos = new THREE.Vector3()
  // the frame's layout, in px: mark centre + mark height
  let cx = 0
  let cy = 0
  let unitPx = 200
  let portrait = false
  let hoverAmt = 0
  const shortLandscape = () => matchMedia('(orientation: landscape) and (max-height: 500px)').matches

  const relayout = (W: number, H: number) => {
    lay = measureHud(hud, W, H, !shortLandscape())
    hud.dirty = false
    lastW = W
    lastH = H
    const a = lay.art
    const aw = Math.max(40, a.x1 - a.x0)
    const ah = Math.max(40, a.y1 - a.y0)
    portrait = lay.portrait
    if (!portrait) {
      unitPx = Math.min(ah * 0.5, aw * 0.4)
      cx = (a.x0 + a.x1) / 2 - MARK_SHIFT * unitPx
      cy = (a.y0 + a.y1) / 2 + ah * 0.02
    } else {
      unitPx = Math.min(ah * 0.62, aw * 0.32)
      cx = (a.x0 + a.x1) / 2 - MARK_SHIFT * unitPx
      cy = (a.y0 + a.y1) / 2
    }
  }

  /** camera distance for this local (a slow, subtle push-in) */
  const distFor = (local: number) => DIST * (1.05 - 0.05 * ease.outCubic(clamp(local / 0.9)))

  return {
    id: 'contact',
    group,
    anchors: [0.3],

    async init(ctx: ChapterContext) {
      hud = buildHud(ctx.stage)
      await nextFrame()
      const c = ctx.post.composer
      set = buildScene({ mobile: ctx.mobile, mainTargets: [c.renderTarget1, c.renderTarget2] })
      group.add(set.rig)
      curveL = new THREE.CatmullRomCurve3(PATH_LANDSCAPE.map(p => new THREE.Vector3(...p)), false, 'centripetal')
      curveP = new THREE.CatmullRomCurve3(PATH_PORTRAIT.map(p => new THREE.Vector3(...p)), false, 'centripetal')
      await nextFrame()
    },

    update(local, frame, ctx) {
      const W = frame.width
      const H = frame.height
      if (hud.dirty || W !== lastW || H !== lastH || !lay) relayout(W, H)

      const rm = frame.reducedMotion
      const t = frame.time
      const settle = smoothstep(0.7, 0.87, local)
      const idle = (rm ? 0.2 : 1) * (1 - settle)
      const slow = rm ? 0.3 : 1

      // ---- place the rig where the card leaves room
      const D = distFor(local)
      const wpp = (2 * D * TAN) / H
      const rig = set.rig
      const S = unitPx * wpp
      rig.position.set((cx - W / 2) * wpp, (H / 2 - cy) * wpp, 0)
      rig.scale.setScalar(S)

      // ---- the mark: a scroll-driven turntable that ends front-on, plus idle float
      const arrive = ease.outCubic(clamp(local / 0.16))
      const yaw = -0.85 * (1 - ease.outCubic(clamp(local / 0.86)))
      // "front-on" means facing the camera: undo the off-axis view angle of the art area
      const faceY = -Math.atan2(rig.position.x, D)
      const faceX = Math.atan2(rig.position.y, D)
      set.turn.rotation.set(
        faceX + 0.07 * Math.sin(t * 0.27 * slow) * idle,
        faceY + yaw + 0.13 * Math.sin(t * 0.33 * slow + 0.6) * idle,
        0.02 * Math.sin(t * 0.21 * slow) * idle,
      )
      set.rings.rotation.set(faceX, faceY, 0)
      set.turn.position.set(0, 0.025 * Math.sin(t * 0.55 * slow) * idle, lerp(-0.25, 0, arrive))
      // the emerald core answers the address: brighter while it's hovered, a soft swell on copy
      hoverAmt = damp(hoverAmt, hud.hover ? 1 : 0, 5, frame.dt)
      const since = (performance.now() - hud.copiedAt) / 1000
      const copied = since >= 0 && since < 1.6 ? Math.sin((since / 1.6) * Math.PI) : 0
      set.mark.glow.intensity = 0.9 + 0.4 * settle + 0.8 * hoverAmt + (rm ? 0.4 : 1) * 1.2 * copied

      // ---- the lens: rises across, holds over the mark, drifts on and recedes to rest
      const u =
        local < 0.3
          ? 0.25 * smoothstep(0.02, 0.3, local)
          : 0.25 + 0.75 * ease.inOutCubic(clamp((local - 0.3) / 0.56))
      ;(portrait ? curveP : curveL).getPoint(clamp(u), lensPos)
      const bob = (rm ? 0.2 : 1) * (1 - settle)
      const px = lensPos.x + 0.02 * Math.sin(t * 0.4 * slow + 1.3) * bob
      const py = lensPos.y + 0.03 * Math.sin(t * 0.47 * slow) * bob
      // undo perspective: nearer/farther points project toward/away from the
      // view centre, so place the lens where it will APPEAR at (px, py)
      const k = (D - lensPos.z * S) / D
      set.lens.position.set(
        ((rig.position.x + px * S) * k - rig.position.x) / S,
        ((rig.position.y + py * S) * k - rig.position.y) / S,
        lensPos.z,
      )

      // ---- listening rings: faint idle drift, one slow pulse outward at the end
      set.ringU.uPhase.value = (rm ? 0 : t * 0.035 * (1 - settle)) + 1.4 * ease.inOutCubic(smoothstep(0.72, 0.9, local))
      set.ringU.uStrength.value = 0.85 + 0.35 * smoothstep(0.74, 0.86, local) - 0.35 * smoothstep(0.9, 1, local)

      // ---- the world: a clear graphite studio, cool ice/aqua pools, one short soft
      // strip behind the mark. Emerald stays the accent: the mark's core, not the room.
      const wp = ctx.world.params
      const aspect = W / H
      const mx = ((cx / W) * 2 - 1) * aspect
      const my = 1 - (cy / H) * 2
      const unitField = (unitPx / H) * 2
      const spread = 1.6
      wp.a = '#62707a'
      wp.b = '#c8d2dc'
      wp.c = '#48506a'
      wp.d = '#5a5690'
      wp.base = '#0a0b0e'
      wp.glow = 0.44 + 0.04 * settle
      wp.flow = rm ? 0.2 : lerp(0.7, 0.3, settle)
      wp.spread = spread
      // only strip 1 (at focus − 0.34·spread): short, just behind the mark's right loop,
      // clear of the core, the card and the top chrome (its height follows the mark's size)
      wp.focus.set(mx + unitField * STRIP_X + 0.34 * spread, my + unitField * 0.08)
      wp.strips = 0.58
      wp.stripMask.set(1, 0, 0)
      wp.stripHeight = clamp(0.3 * unitField, 0.1, 0.22)
      wp.stripColor = '#eef5ff'
      wp.env = 1.3
      // light sweeps: one as the lens arrives, one last, gentle one across the finished
      // still. Both stay where the studio strips lie only along the outer bevels: past
      // ~0.9 a strip faces the camera and floods the flat front faces into chevrons.
      wp.envTurn = rm ? TURN_END : -0.55 + 0.95 * smoothstep(0.12, 0.34, local) + (TURN_END - 0.4) * smoothstep(0.73, 0.87, local)
      wp.keyDir.set(-0.35, 0.72, 0.6)
      wp.key = 1.35
      wp.fill = 0.28

      // ---- post: the focus pull that gives the chapter its name
      const pp = ctx.post.params
      pp.frost = 0.34 * (1 - smoothstep(0.05, 0.17, local))
      // a tight bloom: the core glows, it doesn't haze the whole studio green
      pp.bloomStrength = 0.45 + 0.05 * settle
      pp.bloomRadius = 0.4
      pp.vignette = 0.34

      // ---- copy
      reveal(hud.panel, smoothstep(0.07, 0.15, local))
      setRise(hud.title, local > 0.09)
    },

    camera(local, _frame, out) {
      const D = distFor(local)
      out.position.set(0, 0, D)
      out.target.set(0, 0, 0)
      out.fov = FOV
      out.roll = 0
      out.parallax = 0.3
    },
  }
}
