import * as THREE from 'three'
import { smoothExtrude } from '../../kit/glass'
import { bandColors } from './beam'

/*
 * Geometry and light helpers for the Refraction chapter.
 */

/** Equilateral triangle (apex up) with rounded corners, circumradius R. */
export function prismShape(R: number, r: number): THREE.Shape {
  const V = [0, 1, 2].map(k => {
    const a = Math.PI / 2 + (k * 2 * Math.PI) / 3
    return new THREE.Vector2(Math.cos(a) * R, Math.sin(a) * R)
  })
  // tangent length for a 60° corner with fillet radius r
  const t = r * Math.sqrt(3)
  const s = new THREE.Shape()
  for (let k = 0; k < 3; k++) {
    const p = V[k]
    const prev = V[(k + 2) % 3]
    const next = V[(k + 1) % 3]
    const a = p.clone().add(prev.clone().sub(p).setLength(t))
    const b = p.clone().add(next.clone().sub(p).setLength(t))
    if (k === 0) s.moveTo(a.x, a.y)
    else s.lineTo(a.x, a.y)
    s.quadraticCurveTo(p.x, p.y, b.x, b.y)
  }
  s.closePath()
  return s
}

/** A smooth glass triangular prism, extruded along z and centred. */
export function prismGeometry(R: number, depth: number, bevel: number, mobile: boolean): THREE.BufferGeometry {
  return smoothExtrude(prismShape(R, R * 0.13), {
    depth,
    bevel,
    bevelSegments: mobile ? 4 : 7,
    curveSegments: mobile ? 10 : 16,
    crease: Math.PI / 4,
  })
}

const WASH_FRAG = /* glsl */ `
  uniform vec3 uBands[5];
  uniform float uIntensity, uSpan, uTime, uFlow, uLand;
  uniform vec2 uSize;
  varying vec2 vUv;
  void main() {
    vec2 w = (vUv - 0.5) * uSize;
    // the spectrum as it lands: five soft bands stacked vertically
    vec3 col = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      float off = (float(i) / 4.0 - 0.5) * uSpan;
      float d = (w.y - off) / (uSpan * 0.16);
      col += uBands[i] * exp(-d * d);
    }
    // a bright landing line, a soft spill across the frosted wall, a wide body
    float breathe = 1.0 + uFlow * 0.05 * sin(uTime * 0.9);
    float dx = w.x - uLand;
    float lx = dx / 0.05;
    float sx = dx / (1.25 * breathe);
    float bx = dx / 3.0;
    float line = exp(-lx * lx);
    float spill = exp(-sx * sx);
    float body = exp(-bx * bx);
    float vert = 1.0 - smoothstep(uSpan * 0.5, uSpan * 0.72, abs(w.y));
    float edge = (1.0 - smoothstep(0.38 * uSize.x, 0.5 * uSize.x, abs(w.x))) * (1.0 - smoothstep(0.4 * uSize.y, 0.5 * uSize.y, abs(w.y)));
    vec3 c = col * (line * 3.2 + spill * 1.1 + body * 0.35) * vert;
    gl_FragColor = vec4(c * uIntensity * edge, 1.0);
  }
`

/** The spectrum landing on the frosted wall: additive, sits on the wall face. */
export function wash(w: number, h: number, span: number): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uBands: { value: bandColors() },
      uIntensity: { value: 0 },
      uSpan: { value: span },
      uTime: { value: 0 },
      uFlow: { value: 1 },
      uLand: { value: 0 },
      uSize: { value: new THREE.Vector2(w, h) },
    },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: WASH_FRAG,
  })
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat)
  m.renderOrder = 3
  return m
}

/**
 * Soft light inside a prism (additive, drawn over the glass): a triangle-ish
 * falloff so it stays inside the silhouette. Child of the prism, facing +z.
 */
export function innerGlow(size: number): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: { uStrength: { value: 0 }, uColor: { value: new THREE.Color('#dffff0') } },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform float uStrength; uniform vec3 uColor; varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        // a horizontal lozenge along the beam, brightest at the centre
        float g = exp(-(p.x * p.x * 2.2 + p.y * p.y * 9.0));
        float halo = exp(-(p.x * p.x * 3.0 + p.y * p.y * 3.5)) * 0.35;
        gl_FragColor = vec4(uColor * (g + halo) * uStrength, 1.0);
      }
    `,
  })
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size * 1.4, size), mat)
  m.frustumCulled = false
  return m
}
