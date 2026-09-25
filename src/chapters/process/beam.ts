import * as THREE from 'three'

/*
 * Light for the Refraction chapter: one shader draws every beam segment and
 * the final spectrum fan.
 *
 * A segment is a flat ribbon from A to B. Across it, five brand bands (rose,
 * amber, signal, aqua, iris) are stacked; their colours are normalised so
 * that, laid on top of each other (split = 0), they add up to pure white. As
 * `split` grows along the ribbon the bands pull apart: white light gaining
 * colour. The fan is the same ribbon with a large split and wide bands.
 *
 * Additive, toneMapped false, core > 1 so bloom catches it. `reveal` (0..1)
 * is how far the light has travelled along the ribbon — scroll-driven.
 */

export const BAND_HEX = ['#ff5c9a', '#ffb547', '#00ff85', '#29d9d0', '#6f5cff'] as const

/** Band colours (linear), normalised per channel so the five sum to white. */
export function bandColors(): THREE.Color[] {
  const cols = BAND_HEX.map(h => new THREE.Color(h))
  const sum = cols.reduce((s, c) => s.add(c), new THREE.Color(0, 0, 0))
  return cols.map(c => new THREE.Color(c.r / sum.r, c.g / sum.g, c.b / sum.b))
}

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const FRAG = /* glsl */ `
  uniform vec3 uBands[5];
  uniform vec3 uTint;
  uniform float uIntensity, uReveal, uLen, uWidth, uSplit0, uSplit1, uCore0, uCore1, uHalo, uHaloAmount, uFadeEnd, uFadeStart, uTime, uFlow, uIn0, uIn1, uInside;
  varying vec2 vUv;

  void main() {
    float u = vUv.x;
    float v = (vUv.y - 0.5) * uWidth;          // world units across the ribbon
    float split = mix(uSplit0, uSplit1, u);
    float core = mix(uCore0, uCore1, u);
    float halo = core * uHalo;
    vec3 col = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      float off = (float(i) / 4.0 - 0.5) * split;
      float d = (v - off) / core;
      float h = (v - off) / halo;
      col += uBands[i] * (exp(-d * d) + uHaloAmount * exp(-h * h));
    }
    col *= uTint;

    // the light travels: on behind the head, with a soft leading edge
    float x = u * uLen;
    float head = uReveal * (uLen + 0.4);
    float on = 1.0 - smoothstep(head - 0.4, head, x);
    // a brighter spark rides the head while it is travelling
    float hx = (x - head + 0.12) / 0.16;
    float travelling = smoothstep(0.0, 0.02, uReveal) * (1.0 - smoothstep(0.9, 1.0, uReveal));
    float spark = exp(-hx * hx) * travelling;
    // slow ripple of light along the ribbon (idle life)
    float shimmer = 1.0 + uFlow * 0.07 * sin(x * 5.0 - uTime * 2.4);
    // ends: fade in from the start (fan leaving glass) and out into the wall
    float ends = smoothstep(0.0, uFadeStart, u) * (1.0 - smoothstep(uFadeEnd, 1.0, u));
    // inside the glass the light is quieter (drawn over the prism, no depth test)
    float e = 0.05 / max(uLen, 0.1);
    float outA = uIn0 > 0.0 ? smoothstep(uIn0 - e, uIn0 + e, u) : 1.0;
    float outB = uIn1 > 0.0 ? 1.0 - smoothstep(1.0 - uIn1 - e, 1.0 - uIn1 + e, u) : 1.0;
    float glassDim = mix(uInside, 1.0, outA * outB);
    gl_FragColor = vec4(col * uIntensity * ends * glassDim * (on * shimmer + spark * 1.6), 1.0);
  }
`

export interface BeamOpts {
  /** core width (gaussian sigma, world units) at start / end */
  core0?: number
  core1?: number
  /** band separation (world units) at start / end */
  split0?: number
  split1?: number
  /** halo radius as a multiple of the core */
  halo?: number
  /** halo brightness relative to the core */
  haloAmount?: number
  /** fade the last part of the ribbon (0.999 = no fade) */
  fadeEnd?: number
  /** fade in over the first part (0.001 = no fade) */
  fadeStart?: number
  tint?: THREE.ColorRepresentation
  /** world length of the ribbon inside glass at the start / end (drawn dimmer) */
  inStart?: number
  inEnd?: number
  /** brightness inside glass */
  inside?: number
}

const BANDS = bandColors()

export class Beam {
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  len = 1

  private inStart: number
  private inEnd: number

  constructor(o: BeamOpts = {}) {
    this.inStart = o.inStart ?? 0
    this.inEnd = o.inEnd ?? 0
    const core0 = o.core0 ?? 0.012
    const core1 = o.core1 ?? core0
    const split0 = o.split0 ?? 0
    const split1 = o.split1 ?? split0
    const halo = o.halo ?? 6
    const width = Math.max(split0, split1) + 2 * 3.2 * Math.max(core0, core1) * halo
    this.mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      // light seen through glass: drawn over the prisms, dimmer inside them
      depthTest: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      side: THREE.DoubleSide,
      uniforms: {
        uBands: { value: BANDS },
        uTint: { value: new THREE.Color(o.tint ?? 0xffffff) },
        uIntensity: { value: 0 },
        uReveal: { value: 0 },
        uLen: { value: 1 },
        uWidth: { value: width },
        uSplit0: { value: split0 },
        uSplit1: { value: split1 },
        uCore0: { value: core0 },
        uCore1: { value: core1 },
        uHalo: { value: halo },
        uHaloAmount: { value: o.haloAmount ?? 0.2 },
        uFadeEnd: { value: o.fadeEnd ?? 0.999 },
        uFadeStart: { value: o.fadeStart ?? 0.001 },
        uTime: { value: 0 },
        uFlow: { value: 1 },
        uIn0: { value: 0 },
        uIn1: { value: 0 },
        uInside: { value: o.inside ?? 0.55 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    })
    // x: 0..1 along, y: -0.5..0.5 across
    const g = new THREE.PlaneGeometry(1, 1, 1, 1)
    g.translate(0.5, 0, 0)
    this.mesh = new THREE.Mesh(g, this.mat)
    this.mesh.scale.y = width
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 2
  }

  private static readonly tmpX = new THREE.Vector3()
  private static readonly tmpY = new THREE.Vector3()
  private static readonly tmpZ = new THREE.Vector3()
  private static readonly tmpM = new THREE.Matrix4()

  /**
   * Lay the ribbon from a to b. `up` is the direction the ribbon spreads in
   * (it is made perpendicular to the ribbon).
   */
  place(a: THREE.Vector3, b: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)) {
    const X = Beam.tmpX.subVectors(b, a)
    this.len = X.length()
    X.normalize()
    const Y = Beam.tmpY.copy(up).addScaledVector(X, -up.dot(X)).normalize()
    const Z = Beam.tmpZ.crossVectors(X, Y)
    Beam.tmpM.makeBasis(X, Y, Z)
    this.mesh.quaternion.setFromRotationMatrix(Beam.tmpM)
    this.mesh.position.copy(a)
    this.mesh.scale.x = this.len
    this.mat.uniforms.uLen.value = this.len
    this.mat.uniforms.uIn0.value = this.inStart / this.len
    this.mat.uniforms.uIn1.value = this.inEnd / this.len
    return this
  }

  set(intensity: number, reveal: number, time: number, flow = 1) {
    const u = this.mat.uniforms
    u.uIntensity.value = intensity
    u.uReveal.value = reveal
    u.uTime.value = time
    u.uFlow.value = flow
    this.mesh.visible = intensity > 0.001 && reveal > 0.001
  }
}
