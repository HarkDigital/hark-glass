import * as THREE from 'three'
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'

/*
 * The shield: a thick, curved slab of tempered glass (think a screen
 * protector for a whole website). A rounded-rect extrusion, tessellated so
 * its flat caps have vertices to bend, then curved around the vertical axis
 * (and a little around the horizontal) so the studio strips run across it as
 * long clean highlights and the site behind it bends toward the edges.
 */
export function curvedSlab(
  w: number,
  h: number,
  o: { radius: number; depth: number; bevel: number; bendX: number; bendY: number; maxEdge: number; bevelSegments: number },
): THREE.BufferGeometry {
  const r = Math.min(o.radius, w / 2, h / 2)
  const x = -w / 2
  const y = -h / 2
  const s = new THREE.Shape()
  s.moveTo(x + r, y)
  s.lineTo(x + w - r, y)
  s.absarc(x + w - r, y + r, r, -Math.PI / 2, 0, false)
  s.lineTo(x + w, y + h - r)
  s.absarc(x + w - r, y + h - r, r, 0, Math.PI / 2, false)
  s.lineTo(x + r, y + h)
  s.absarc(x + r, y + h - r, r, Math.PI / 2, Math.PI, false)
  s.lineTo(x, y + r)
  s.absarc(x + r, y + r, r, Math.PI, Math.PI * 1.5, false)
  const ex = new THREE.ExtrudeGeometry(s, {
    depth: o.depth,
    bevelEnabled: true,
    bevelThickness: o.bevel,
    bevelSize: o.bevel * 0.9,
    bevelSegments: o.bevelSegments,
    curveSegments: 14,
    steps: 1,
  })
  ex.translate(0, 0, -o.depth / 2)
  ex.deleteAttribute('normal')
  ex.deleteAttribute('uv')
  const t = new TessellateModifier(o.maxEdge, 18).modify(ex)
  ex.dispose()
  const p = t.attributes.position
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i)
    const py = p.getY(i)
    p.setZ(i, p.getZ(i) - (px * px) / (2 * o.bendX) - (py * py) / (2 * o.bendY))
  }
  const out = toCreasedNormals(t, 0.62)
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}
