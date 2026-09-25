import { rng } from '../../core/math'

/*
 * The breach: a procedural fracture across the site pane.
 *
 * From an impact point, `rays` radial cracks run out to the pane's rounded
 * outline (spaced by perimeter length so the pieces come out similar in
 * size), a jagged ring closes around the impact, and the cells between them
 * become the shards: one small core plus one wedge per ray. Decorative
 * cracks (spider lines through the core, branches off the rays, partial
 * concentric arcs) live inside a single shard, so they travel with it.
 *
 * Every crack point carries a growth time `g` (≈ distance from the impact,
 * 0..~1.1) so the fracture can be grown — and retracted — by scroll.
 * Edges two shards share are handed to BOTH with weight 0.5: drawn
 * additively they sum to one full line while the shards are seated, and each
 * broken edge keeps half a line of light when they part.
 */

export type V2 = [number, number]

export interface CrackLine {
  pts: V2[]
  /** growth time per point */
  g: number[]
  /** width at the start and the end of the line (world units) */
  w0: number
  w1: number
  /** brightness weight (0.5 on shared edges) */
  k: number
}

export interface Shard {
  /** CCW polygon, pane-local */
  poly: V2[]
  centroid: V2
  /** unit direction from the impact to the centroid */
  dir: V2
  lines: CrackLine[]
  core: boolean
}

export interface Cracks {
  outline: V2[]
  shards: Shard[]
  impact: V2
  /** farthest crack reach from the impact (growth is normalised by it) */
  reach: number
}

const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]]
const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]]
const mul = (a: V2, s: number): V2 => [a[0] * s, a[1] * s]
const len = (a: V2) => Math.hypot(a[0], a[1])
const cross = (a: V2, b: V2) => a[0] * b[1] - a[1] * b[0]
const norm = (a: V2): V2 => {
  const l = len(a) || 1
  return [a[0] / l, a[1] / l]
}
const dirOf = (ang: number): V2 => [Math.cos(ang), Math.sin(ang)]
const TAU = Math.PI * 2
const wrap = (a: number) => ((a % TAU) + TAU) % TAU

/**
 * Rounded rectangle outline, CCW, using the same quadratic corners as the
 * kit's pane() so an extruded outline matches it exactly.
 */
export function roundedRect(w: number, h: number, r: number, n = 10): V2[] {
  const x0 = -w / 2
  const y0 = -h / 2
  const x1 = w / 2
  const y1 = h / 2
  const pts: V2[] = []
  const quad = (a: V2, c: V2, b: V2) => {
    for (let i = 1; i <= n; i++) {
      const t = i / n
      const u = 1 - t
      pts.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]])
    }
  }
  pts.push([x0 + r, y0], [x1 - r, y0])
  quad([x1 - r, y0], [x1, y0], [x1, y0 + r])
  pts.push([x1, y1 - r])
  quad([x1, y1 - r], [x1, y1], [x1 - r, y1])
  pts.push([x0 + r, y1])
  quad([x0 + r, y1], [x0, y1], [x0, y1 - r])
  pts.push([x0, y0 + r])
  quad([x0, y0 + r], [x0, y0], [x0 + r, y0])
  pts.pop() // the last corner ends where we started
  return pts
}

/** Where a ray from p along d leaves the (convex) outline. */
function hitOutline(p: V2, d: V2, outline: V2[]) {
  const N = outline.length
  let best = { k: -1, t: Infinity, pt: p as V2 }
  for (let k = 0; k < N; k++) {
    const a = outline[k]
    const e = sub(outline[(k + 1) % N], a)
    const den = cross(d, e)
    if (Math.abs(den) < 1e-12) continue
    const ap = sub(a, p)
    const t = cross(ap, e) / den
    const s = cross(ap, d) / den
    if (t > 1e-6 && s >= -1e-9 && s <= 1 + 1e-9 && t < best.t) best = { k, t, pt: add(p, mul(d, t)) }
  }
  return best
}

/** Point at arc length s along a closed outline, and the segment it lies on. */
function alongOutline(outline: V2[], s: number) {
  const N = outline.length
  let total = 0
  for (let k = 0; k < N; k++) total += len(sub(outline[(k + 1) % N], outline[k]))
  let rest = wrap(s / total) * total
  for (let k = 0; k < N; k++) {
    const a = outline[k]
    const e = sub(outline[(k + 1) % N], a)
    const l = len(e)
    if (rest <= l) return { k, pt: add(a, mul(e, rest / Math.max(l, 1e-9))) as V2, total }
    rest -= l
  }
  return { k: N - 1, pt: outline[N - 1], total }
}

/** Point at fraction f of a polyline's length. */
function alongLine(pts: V2[], f: number): V2 {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += len(sub(pts[i], pts[i - 1]))
  let rest = f * total
  for (let i = 1; i < pts.length; i++) {
    const e = sub(pts[i], pts[i - 1])
    const l = len(e)
    if (rest <= l) return add(pts[i - 1], mul(e, rest / Math.max(l, 1e-9)))
    rest -= l
  }
  return pts[pts.length - 1]
}

function centroidOf(poly: V2[]): V2 {
  let a = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    const c = cross(p, q)
    a += c
    cx += (p[0] + q[0]) * c
    cy += (p[1] + q[1]) * c
  }
  a *= 0.5
  if (Math.abs(a) < 1e-9) return poly[0]
  return [cx / (6 * a), cy / (6 * a)]
}

/** Drop consecutive near-duplicates (degenerate edges break extrusion normals). */
function clean(poly: V2[]): V2[] {
  const out: V2[] = []
  for (const p of poly) {
    const last = out[out.length - 1]
    if (!last || len(sub(p, last)) > 2e-3) out.push(p)
  }
  while (out.length > 3 && len(sub(out[0], out[out.length - 1])) <= 2e-3) out.pop()
  return out
}

export function buildCracks(o: { w: number; h: number; radius: number; impact: V2; rays: number; seed: number }): Cracks {
  const R = rng(o.seed)
  const P = o.impact
  const n = o.rays
  const outline = roundedRect(o.w, o.h, o.radius)
  const N = outline.length
  const inset = 0.07
  const inside = (p: V2) => Math.abs(p[0]) < o.w / 2 - inset && Math.abs(p[1]) < o.h / 2 - inset
  const clampIn = (p: V2): V2 => [
    Math.max(-o.w / 2 + inset, Math.min(o.w / 2 - inset, p[0])),
    Math.max(-o.h / 2 + inset, Math.min(o.h / 2 - inset, p[1])),
  ]

  // --- ray ends: evenly spaced by perimeter length (similar-sized pieces)
  const total = alongOutline(outline, 0).total
  const s0 = R() * total
  const ends = Array.from({ length: n }, (_, i) => {
    const s = s0 + ((i + (R() - 0.5) * 0.45) / n) * total
    const hit = alongOutline(outline, s)
    return { ...hit, ang: Math.atan2(hit.pt[1] - P[1], hit.pt[0] - P[0]) }
  })
  // CCW order around the impact (== order along the outline for a convex shape)
  const ref = ends[0].ang
  ends.sort((a, b) => wrap(a.ang - ref) - wrap(b.ang - ref))
  const ang = ends.map(e => e.ang)
  const span = ang.map((a, i) => wrap(ang[(i + 1) % n] - a) || TAU)
  const reach = Math.max(...ends.map(e => len(sub(e.pt, P))))
  const G = (p: V2) => len(sub(p, P)) / reach

  // --- the ring around the impact
  const ringR = Math.min(0.46, 0.3 * reach)
  const ring = ang.map(a => add(P, mul(dirOf(a), ringR * (0.74 + 0.5 * R()))))
  // two kinks per ring segment, irregular in radius (real impact rings are never polygons)
  const mid = ang.map((a, i) => [
    add(P, mul(dirOf(a + span[i] * (0.26 + 0.14 * R())), ringR * (0.72 + 0.5 * R()))),
    add(P, mul(dirOf(a + span[i] * (0.58 + 0.16 * R())), ringR * (0.78 + 0.46 * R()))),
  ])

  // --- rays: ring point → outline, with a few kinks
  const rays: V2[][] = ends.map((e, i) => {
    const a = ring[i]
    const b = e.pt
    const d = sub(b, a)
    const L = len(d)
    const perp: V2 = [-d[1] / L, d[0] / L]
    const pts: V2[] = [a]
    for (const f of [0.26, 0.5, 0.74]) {
      const ff = f + (R() - 0.5) * 0.08
      const off = (R() - 0.5) * 0.11 * Math.min(1, L / 1.2)
      pts.push(clampIn(add(add(a, mul(d, ff)), mul(perp, off))))
    }
    pts.push(b)
    return pts
  })

  const line = (pts: V2[], w0: number, w1: number, k: number, g?: number[]): CrackLine => ({
    pts,
    g: g ?? pts.map(G),
    w0,
    w1,
    k,
  })
  const rayLines = rays.map(pts => line(pts, 0.015, 0.006, 0.5))
  const ringLines = ang.map((_, i) => {
    const pts = [ring[i], mid[i][0], mid[i][1], ring[(i + 1) % n]]
    return line(pts, 0.011, 0.011, 0.5, pts.map(p => G(p) + 0.03))
  })

  const shards: Shard[] = []

  // --- the core: the impact zone, spider-cracked
  const corePoly = clean(ring.flatMap((p, i) => [p, mid[i][0], mid[i][1]]))
  const coreLines: CrackLine[] = [...ringLines]
  // spider lines continue each ray into the impact
  ang.forEach((a, i) => {
    const r = ring[i]
    const m = add(P, mul(dirOf(a + (R() - 0.5) * 0.12), len(sub(r, P)) * 0.5))
    coreLines.push(line([add(P, mul(dirOf(a), 0.03)), m, r], 0.012, 0.014, 1))
  })
  // short stubs between them
  ang.forEach((a, i) => {
    if (R() < 0.35) return
    const b = a + span[i] * (0.35 + 0.3 * R())
    const r = ringR * (0.45 + 0.3 * R())
    coreLines.push(line([add(P, mul(dirOf(b), 0.035)), add(P, mul(dirOf(b + (R() - 0.5) * 0.1), r))], 0.01, 0.0055, 1))
  })
  // a tiny crushed ring at the point of impact
  {
    const pts: V2[] = []
    const m = 11
    for (let j = 0; j <= m; j++) {
      const t = (j / m) * TAU
      pts.push(add(P, mul(dirOf(t), 0.05 * (0.85 + 0.3 * R()))))
    }
    pts[m] = pts[0]
    coreLines.push(line(pts, 0.008, 0.008, 1, pts.map(() => 0.012)))
  }
  shards.push({ poly: corePoly, centroid: centroidOf(corePoly), dir: [0, 0], lines: coreLines, core: true })

  // --- wedges between neighbouring rays
  const inWedge = (p: V2, j: number, margin: number) => {
    const d = wrap(Math.atan2(p[1] - P[1], p[0] - P[0]) - ang[j])
    return d > margin && d < span[j] - margin
  }
  const wedgeLines: CrackLine[][] = ang.map(() => [])
  // branches off each ray, into one neighbouring wedge
  rays.forEach((pts, i) => {
    const count = R() < 0.55 ? 2 : 1
    for (let b = 0; b < count; b++) {
      const f = 0.28 + R() * 0.46
      const O = alongLine(pts, f)
      const side = R() < 0.5 ? 1 : -1
      const owner = side > 0 ? i : (i - 1 + n) % n
      const dist = len(sub(O, P))
      const a0 = ang[i] + side * (0.42 + R() * 0.36)
      const L = Math.min(0.5, (0.16 + R() * 0.2) * Math.max(0.5, dist))
      const cand: V2[] = [
        add(O, mul(dirOf(a0 + (R() - 0.5) * 0.3), L * 0.5)),
        add(O, mul(dirOf(a0 + (R() - 0.5) * 0.25), L)),
      ]
      const bp: V2[] = [O]
      for (const c of cand) {
        if (!inside(c) || !inWedge(c, owner, 0.07)) break
        bp.push(c)
      }
      if (bp.length < 2) continue
      const g0 = G(O)
      let acc = 0
      const g = bp.map((p, j) => {
        if (j > 0) acc += len(sub(p, bp[j - 1]))
        return g0 + (acc / reach) * 1.3
      })
      wedgeLines[owner].push(line(bp, 0.01, 0.0055, 1, g))
      // a twig off the branch's end
      if (bp.length === 3 && R() < 0.5) {
        const e = bp[2]
        const tw = add(e, mul(dirOf(a0 - side * (0.5 + R() * 0.3)), L * 0.35))
        if (inside(tw) && inWedge(tw, owner, 0.07)) wedgeLines[owner].push(line([e, tw], 0.0065, 0.005, 1, [g[2], g[2] + (L * 0.35 * 1.3) / reach]))
      }
    }
  })
  // partial concentric arcs
  ang.forEach((a, i) => {
    if (R() < 0.4) return
    const rMax = Math.min(len(sub(ends[i].pt, P)), len(sub(ends[(i + 1) % n].pt, P)))
    const r2 = ringR * (1.8 + R() * 0.9)
    if (r2 > rMax * 0.8) return
    const sweep = span[i] * (0.32 + R() * 0.36)
    const m = 6
    const pts: V2[] = []
    for (let j = 0; j <= m; j++) {
      const t = a + 0.04 + (sweep * j) / m
      const r = r2 * (1 + (R() - 0.5) * 0.07)
      const p = add(P, mul(dirOf(t), r))
      const lim = hitOutline(P, dirOf(t), outline).t
      if (r > lim * 0.88 || !inside(p)) break
      pts.push(p)
    }
    if (pts.length < 3) return
    const g0 = G(pts[0])
    let acc = 0
    const g = pts.map((p, j) => {
      if (j > 0) acc += len(sub(p, pts[j - 1]))
      return g0 + (acc / reach) * 1.1
    })
    wedgeLines[i].push(line(pts, 0.009, 0.0055, 1, g))
  })

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const poly: V2[] = [...rays[i]]
    // walk the outline CCW from ray i's end to ray j's end
    const bi = ends[i]
    const bj = ends[j]
    let k = bi.k
    let guard = 0
    while (k !== bj.k && guard++ < N) {
      k = (k + 1) % N
      const p = outline[k]
      if (len(sub(p, bi.pt)) > 4e-3 && len(sub(p, bj.pt)) > 4e-3) poly.push(p)
    }
    for (let q = rays[j].length - 1; q >= 0; q--) poly.push(rays[j][q])
    poly.push(mid[i][1], mid[i][0])
    const cp = clean(poly)
    const c = centroidOf(cp)
    shards.push({
      poly: cp,
      centroid: c,
      dir: norm(sub(c, P)),
      lines: [rayLines[i], rayLines[j], ringLines[i], ...wedgeLines[i]],
      core: false,
    })
  }

  return { outline, shards, impact: P, reach }
}
