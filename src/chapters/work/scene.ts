import * as THREE from 'three'
import { G, caustic, edgeGlow, glass, pane } from '../../kit/glass'
import { placeholderTexture } from '../../kit/images'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { logoParts } from '../../logo/logo'
import type { WorkItem } from '../../content'
import { MONO, SANS, spaced, textPlate, type TextPlate } from './text'

/*
 * The Vitrine set: six thick glass display blocks standing on a gentle arc of
 * dark polished plinth, each with its project's screenshot embedded just
 * inside the front face (legible, refracted when the block turns), an etched
 * plaque and a small emerald status inlay; soft caustic pools under each.
 * At the end of the plinth, a stack of nine thin frosted index cards (the
 * rest of the portfolio) that fans open in depth.
 *
 * Geometry: the arc is a circle of radius R around C = (0, 0, R), so the
 * blocks curve gently toward the viewer at the ends and all face C.
 */

export const R = 14
export const DELTA = 0.18
/** arc angle of featured block k (centred on 0) */
export const theta = (k: number) => (k - 2.5) * DELTA
/** arc angle of the nine-card stack, past the last block */
export const STACK_THETA = theta(5) + DELTA * 1.75

/** point on the arc (radius r around C) */
export function onArc(th: number, r = R, out = new THREE.Vector3()) {
  return out.set(r * Math.sin(th), 0, R - r * Math.cos(th))
}
/** unit normal toward the arc centre (the way a block faces at rest) */
export function arcNormal(th: number, out = new THREE.Vector3()) {
  return out.set(-Math.sin(th), 0, Math.cos(th))
}

/* block dimensions (outer, incl. bevel): 1.80 x 1.24 x 0.28 — a generous clear margin round the screenshot */
export const BW = 1.8
export const BH = 1.24
const B_DEPTH = 0.19
const B_BEVEL = 0.045
export const FRONT = B_DEPTH / 2 + B_BEVEL
/** screenshot inside the block (1280x800 aspect), sitting a little high like a mount */
export const IW = 1.4
export const IH = IW * 0.625
export const IMG_Y = 0.06
/** centre of the flat bottom margin (below the screenshot, above the bevel) */
export const PLAQUE_Y = (-BH / 2 + B_BEVEL + (IMG_Y - IH / 2)) / 2
/** the block's centre height above the plinth top */
export const LIFT = 0.07 + BH / 2

/* plinth: an arc band from just before the first block to past the stack */
const P_IN = R - 0.46
const P_OUT = R + 0.3
const P_A = theta(0) - 0.3
const P_B = STACK_THETA + 0.2
const P_THICK = 0.035
const P_BEVEL = 0.018

/* index cards */
export const CW = 1.56
export const CH = 0.62

export const ACCENTS = ['#29d9d0', '#8a7dff', '#4f8bff', '#9dffd0', '#ff6fa6', '#00ff85']

export interface Block {
  station: THREE.Group
  pivot: THREE.Group
  glass: THREE.Mesh
  glassMat: THREE.MeshPhysicalMaterial
  shot: THREE.Mesh
  shotMat: THREE.MeshBasicMaterial
  plaque: TextPlate
  gemMat: THREE.MeshBasicMaterial
  /** fresnel rim: the edge-lit acrylic glow along bevels and sides */
  rimMat: THREE.ShaderMaterial
  pool: THREE.Mesh
  poolMat: THREE.ShaderMaterial
}

export interface Card {
  root: THREE.Group
  glass: THREE.Mesh
  mat: THREE.MeshPhysicalMaterial
  name: TextPlate
}

export interface Gallery {
  root: THREE.Group
  blocks: Block[]
  stack: THREE.Group
  cards: Card[]
  plinth: THREE.Mesh
  line: THREE.Mesh
  lineMat: THREE.MeshBasicMaterial
  stackPool: THREE.Mesh
  stackPoolMat: THREE.ShaderMaterial
}

/** A plane with rounded corners and 0..1 UVs across its whole rectangle. */
function roundedPlane(w: number, h: number, r: number): THREE.BufferGeometry {
  const s = new THREE.Shape()
  const x = -w / 2
  const y = -h / 2
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + h - r)
  s.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  s.lineTo(x + r, y + h)
  s.quadraticCurveTo(x, y + h, x, y + h - r)
  s.lineTo(x, y + r)
  s.quadraticCurveTo(x, y, x + r, y)
  const g = new THREE.ShapeGeometry(s, 5)
  const pos = g.attributes.position
  const uv = g.attributes.uv
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) - x) / w, (pos.getY(i) - y) / h)
  uv.needsUpdate = true
  return g
}

/** The mark's diamond as a flat shape, centred, `size` tall. */
function diamondGeometry(size: number): THREE.BufferGeometry {
  const g = new THREE.ShapeGeometry(logoParts().diamond, 2)
  g.computeBoundingBox()
  const b = g.boundingBox!
  const s = size / Math.max(1e-6, b.max.y - b.min.y)
  g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, 0)
  g.scale(s, s, 1)
  return g
}

/** The plinth: an annular band with rounded ends, bevelled, top at y = 0. */
function plinthGeometry(): THREE.BufferGeometry {
  // shape coords: (x, y) -> world (x, -z) after rotateX(-PI/2); arc centre (0, -R)
  const s = new THREE.Shape()
  const hr = (P_OUT - P_IN) / 2
  const rm = (P_OUT + P_IN) / 2
  const cap = (th: number) => new THREE.Vector2(rm * Math.sin(th), -R + rm * Math.cos(th))
  const a0 = Math.PI / 2 - P_A
  const a1 = Math.PI / 2 - P_B
  s.moveTo(P_OUT * Math.cos(a0), -R + P_OUT * Math.sin(a0))
  s.absarc(0, -R, P_OUT, a0, a1, true)
  const cb = cap(P_B)
  s.absarc(cb.x, cb.y, hr, a1, a1 - Math.PI, true)
  s.absarc(0, -R, P_IN, a1, a0, false)
  const ca = cap(P_A)
  s.absarc(ca.x, ca.y, hr, a0 - Math.PI, a0 - 2 * Math.PI, true)
  const g = new THREE.ExtrudeGeometry(s, {
    depth: P_THICK,
    bevelEnabled: true,
    bevelThickness: P_BEVEL,
    bevelSize: P_BEVEL,
    bevelSegments: 3,
    curveSegments: 96,
    steps: 1,
  })
  g.rotateX(-Math.PI / 2)
  // extrusion ran along +z -> now +y; put the top face (incl. bevel) at y = 0
  g.translate(0, -(P_THICK + P_BEVEL), 0)
  // a small crease angle: smooth along the arc, but the flat top must stay
  // flat (averaging it with the bevel tilts its long triangles into streaks)
  const out = toCreasedNormals(g, 0.28)
  g.dispose()
  return out
}

class ArcCurve extends THREE.Curve<THREE.Vector3> {
  constructor(
    private r: number,
    private a: number,
    private b: number,
    private y: number,
  ) {
    super()
  }
  getPoint(t: number, out = new THREE.Vector3()) {
    const th = this.a + (this.b - this.a) * t
    return onArc(th, this.r, out).setY(this.y)
  }
}

const pad = (n: number) => String(n).padStart(2, '0')

/**
 * three samples the transmission buffer through a bicubic mip blur even at
 * roughness 0 (its roughness floor is 0.0525), which softens a screenshot
 * seen through the glass. For the display blocks, sample the base level.
 */
const LOD_RE = /float lod = log2\( transmissionSamplerSize\.x \) \* applyIorToRoughness\( roughness, ior \);\s*return textureBicubic\( transmissionSamplerMap, fragCoord\.xy, lod \);/
function sharpTransmission(m: THREE.MeshPhysicalMaterial) {
  const chunk = THREE.ShaderChunk.transmission_pars_fragment
  if (!LOD_RE.test(chunk)) return
  const sharp = chunk.replace(LOD_RE, 'return textureLod( transmissionSamplerMap, fragCoord.xy, 0.0 );')
  m.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <transmission_pars_fragment>', sharp)
  }
  m.customProgramCacheKey = () => 'wk-sharp-transmission'
}

export function buildGallery(featured: WorkItem[], rest: WorkItem[], mobile: boolean): Gallery {
  const root = new THREE.Group()
  root.name = 'vitrine'

  // ---------------------------------------------------------------- plinth
  const plinthMat = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#070a11'),
    roughness: 0.18,
    metalness: 0,
    specularIntensity: 0.3,
    clearcoat: 0.6,
    clearcoatRoughness: 0.08,
    envMapIntensity: 0.1,
  })
  const plinth = new THREE.Mesh(plinthGeometry(), plinthMat)
  root.add(plinth)
  // a hairline of light set into the plinth's front edge (museum vitrine LED)
  const lineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#9d92ff').multiplyScalar(2.2), toneMapped: false })
  const line = new THREE.Mesh(
    new THREE.TubeGeometry(new ArcCurve(P_IN - P_BEVEL - 0.001, P_A + 0.01, P_B - 0.01, -(P_THICK + P_BEVEL) / 2 - P_BEVEL / 2), mobile ? 120 : 240, 0.0065, 6, false),
    lineMat,
  )
  root.add(line)

  // ---------------------------------------------------------------- blocks
  const blockGeo = pane(BW - 2 * B_BEVEL * 0.85, BH - 2 * B_BEVEL * 0.85, { depth: B_DEPTH, bevel: B_BEVEL, radius: 0.075 }).geometry
  const shotGeo = roundedPlane(IW, IH, 0.018)
  const gemGeo = diamondGeometry(0.07)
  const baseGlass = glass({ thickness: 0.32, frost: 0, dispersion: 0.45, env: 1.2, coat: 0.2, ior: 1.5 })
  // on phones the transmission pass renders at half resolution: keep the
  // screenshot ON the face there so it stays sharp; desktop embeds it in the
  // middle of the slab (seen through the front face, refracted when it turns)
  const shotZ = mobile ? FRONT + 0.003 : -0.01
  const blocks: Block[] = featured.map((w, k) => {
    const th = theta(k)
    const station = new THREE.Group()
    onArc(th, R, station.position)
    station.rotation.y = -th
    const pivot = new THREE.Group()
    pivot.position.y = LIFT
    station.add(pivot)

    const glassMat = baseGlass.clone()
    sharpTransmission(glassMat)
    const g = new THREE.Mesh(blockGeo, glassMat)
    pivot.add(g)
    const rimMat = edgeGlow(new THREE.Color(ACCENTS[k % ACCENTS.length]).lerp(new THREE.Color('#ffffff'), 0.45), 2.5, 0.3)
    const rim = new THREE.Mesh(blockGeo, rimMat)
    rim.scale.setScalar(1.004)
    rim.renderOrder = 2
    pivot.add(rim)

    const shotMat = new THREE.MeshBasicMaterial({ map: placeholderTexture('#141a24'), toneMapped: true })
    shotMat.color.setScalar(0.85)
    const shot = new THREE.Mesh(shotGeo, shotMat)
    shot.position.set(0, IMG_Y, shotZ)
    pivot.add(shot)

    // etched plaque in the bottom margin: number + name
    const plaque = textPlate(1400, 84, 1.3, (c, pw, ph) => {
      c.font = `500 34px ${MONO}`
      c.globalAlpha = 0.62
      const x = 2 + spaced(c, pad(k + 1), 2, ph / 2, 3)
      c.globalAlpha = 0.95
      spaced(c, w.name.toUpperCase(), x + 40, ph / 2, 5)
      void pw
    })
    plaque.mesh.position.set(-0.035, PLAQUE_Y, FRONT + 0.0025)
    pivot.add(plaque.mesh)

    // the emerald status inlay (opaque, inside the glass: seen refracted, blooms)
    const gemMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(G.signal), toneMapped: false })
    const gem = new THREE.Mesh(gemGeo, gemMat)
    gem.position.set(IW / 2 - 0.035, plaque.mesh.position.y, mobile ? FRONT + 0.003 : -0.01)
    pivot.add(gem)

    // soft light pool on the plinth
    const pool = caustic({ size: 1, color: ACCENTS[k % ACCENTS.length], strength: 0.4 })
    pool.scale.set(2.4, 0.74, 1)
    pool.position.set(0, 0.003, 0.08)
    station.add(pool)

    root.add(station)
    return { station, pivot, glass: g, glassMat, shot, shotMat, plaque, gemMat, rimMat, pool, poolMat: pool.material as THREE.ShaderMaterial }
  })

  // ---------------------------------------------------------------- stack
  const stack = new THREE.Group()
  onArc(STACK_THETA, R, stack.position)
  stack.rotation.y = -STACK_THETA
  root.add(stack)
  const cardGeo = pane(CW - 0.02, CH - 0.02, { depth: 0.022, bevel: 0.012, radius: 0.055 }).geometry
  const cardGlass = glass({ frost: 0.3, thickness: 0.12, dispersion: 0, env: 1.05, coat: 0.3 })
  const cards: Card[] = rest.map((w, j) => {
    const root = new THREE.Group()
    const mat = cardGlass.clone()
    const g = new THREE.Mesh(cardGeo, mat)
    root.add(g)
    const name = textPlate(2048, 150, CW - 0.12, (c, pw, ph) => {
      c.font = `500 44px ${MONO}`
      c.globalAlpha = 0.66
      const x = spaced(c, pad(featured.length + j + 1), 4, ph / 2 + 2, 2)
      c.globalAlpha = 1
      c.font = `520 74px ${SANS}`
      const nx = x + 46
      const nw = spaced(c, w.name, nx, ph / 2 + 2, -1.2)
      // the industry, right-aligned in mono caps (only when it clears the name)
      c.font = `500 34px ${MONO}`
      const ind = w.industry.toUpperCase()
      const iw = spaced(c, ind, 0, 0, 5, true)
      if (nx + nw + 80 < pw - 8 - iw) {
        c.globalAlpha = 0.55
        spaced(c, ind, pw - 8 - iw, ph / 2 + 2, 5)
      }
    })
    name.mesh.position.set(0, CH / 2 - 0.075, 0.011 + 0.012 + 0.002)
    root.add(name.mesh)
    stack.add(root)
    return { root, glass: g, mat, name }
  })
  const stackPool = caustic({ size: 1, color: '#8a7dff', strength: 0.35 })
  stackPool.scale.set(2.3, 0.74, 1)
  stackPool.position.set(0, 0.003, 0.08)
  stack.add(stackPool)

  return {
    root,
    blocks,
    stack,
    cards,
    plinth,
    line,
    lineMat,
    stackPool,
    stackPoolMat: stackPool.material as THREE.ShaderMaterial,
  }
}
