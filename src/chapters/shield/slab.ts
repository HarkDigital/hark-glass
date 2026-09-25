import * as THREE from 'three'
import { TessellateModifier } from 'three/addons/modifiers/TessellateModifier.js'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'

/*
 * The shield: a thick, convex crest of tempered glass that stands in front of
 * the site with an air gap. Its outline is a classic shield (a gently domed
 * top, straight flanks, a soft point below) sized to clear the pane on every
 * side, so the silhouette reads as a shield rather than a bezel. The
 * extrusion is tessellated so its flat caps have vertices to bend, then
 * curved around the vertical axis (and a little around the horizontal) so the
 * studio's reflections run across it as long clean highlights and the site
 * behind it bends toward the edges.
 */

/** Crest outline in pane units (the pane is 3.2 x 2.1, centred on the origin). */
export function crestShape(): THREE.Shape {
  const hw = 1.95 // half width: 0.35 clear of the pane's flanks
  const yS = 1.16 // top of the straight flanks
  const r = 0.42 // shoulder radius
  const yC = 1.42 // the dome's crown
  const yT = -0.36 // where the flanks start to taper
  const yP = -2.1 // the point
  // the shoulder hands over to the dome with a matching slope (no kink)
  const y0 = (yS / r + (2 * yC) / (hw - r)) / (1 / r + 2 / (hw - r))
  const tip = new THREE.Vector2(0.11, yP + 0.06)
  const s = new THREE.Shape()
  s.moveTo(-tip.x, tip.y)
  s.quadraticCurveTo(0, yP, tip.x, tip.y)
  s.bezierCurveTo(1.1, -1.5, hw, -1.42, hw, yT)
  s.lineTo(hw, yS - r)
  s.quadraticCurveTo(hw, yS, hw - r, y0)
  s.quadraticCurveTo(0, 2 * yC - y0, -(hw - r), y0)
  s.quadraticCurveTo(-hw, yS, -hw, yS - r)
  s.lineTo(-hw, yT)
  s.bezierCurveTo(-hw, -1.42, -1.1, -1.5, -tip.x, tip.y)
  return s
}

export function curvedSlab(
  shape: THREE.Shape,
  o: {
    depth: number
    bevel: number
    /** bend radii about the vertical / horizontal axes */
    bendX: number
    bendY: number
    /** where the bend is centred (the dome's apex) */
    cx?: number
    cy?: number
    maxEdge: number
    bevelSegments: number
  },
): THREE.BufferGeometry {
  const ex = new THREE.ExtrudeGeometry(shape, {
    depth: o.depth,
    bevelEnabled: true,
    bevelThickness: o.bevel,
    bevelSize: o.bevel * 0.9,
    bevelSegments: o.bevelSegments,
    curveSegments: 16,
    steps: 1,
  })
  ex.translate(0, 0, -o.depth / 2)
  ex.deleteAttribute('normal')
  ex.deleteAttribute('uv')
  const t = new TessellateModifier(o.maxEdge, 18).modify(ex)
  ex.dispose()
  const p = t.attributes.position
  const cx = o.cx ?? 0
  const cy = o.cy ?? 0
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i) - cx
    const py = p.getY(i) - cy
    p.setZ(i, p.getZ(i) - (px * px) / (2 * o.bendX) - (py * py) / (2 * o.bendY))
  }
  const out = toCreasedNormals(t, 0.62)
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

/**
 * The shield's light: a fresnel rim (the bevels and the curved flanks catch
 * the studio as an outline of light) plus a single sweep, a band of light
 * that runs diagonally across the crest as it arrives: brightest on the rim,
 * a crisp streak across the face. Additive, no depth writes; drawn with the
 * slab's own geometry.
 */
export function shieldLightMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uColor: { value: new THREE.Color() },
      uSweepColor: { value: new THREE.Color() },
      uRim: { value: 0 },
      uSweep: { value: -3 },
      uBand: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying vec2 vP; varying float vFront;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        vP = position.xy;
        vFront = normal.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor, uSweepColor;
      uniform float uRim, uSweep, uBand;
      varying vec3 vN; varying vec3 vV; varying vec2 vP; varying float vFront;
      void main() {
        float f = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float rim = f * f * f;               // no pow() on a possibly-negative base
        float d = dot(vP, vec2(0.55, 0.835)) - uSweep;
        float band = exp(-d * d / 0.12);
        float streak = exp(-d * d / 0.004);
        float face = smoothstep(0.35, 0.8, vFront);
        vec3 c = uColor * rim * uRim;
        c += uSweepColor * (rim * 2.2 * band + (0.05 * band + 0.22 * streak) * face) * uBand;
        gl_FragColor = vec4(c, 1.0);
      }
    `,
  })
}
