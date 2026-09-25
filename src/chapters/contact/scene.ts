import * as THREE from 'three'
import { G, glass, glassLogo, type GlassLogo } from '../../kit/glass'

/*
 * CLEAR — the 3D set for the contact chapter.
 *
 *   rig    positioned + scaled each frame so the mark sits in the free "art"
 *          area beside (landscape) or above (portrait) the contact panel.
 *          1 rig unit = the mark's height.
 *   turn   the mark's slow turntable (yaw/tilt/float), inside the rig.
 *   mark   the Hark mark in thick clear glass with its emerald core.
 *   lens   a big clear glass sphere that drifts across in front of the mark.
 *          three's transmission model offsets the refracted sample by
 *          `thickness` along the refracted ray; a thickness of a few radii
 *          makes the sphere behave like a real ball lens: the image behind it
 *          is FLIPPED and magnified.
 *   rings  thin "listening" rings of light etched behind the mark (additive
 *          but in the OPAQUE list, so the transmission pass captures them and
 *          both the mark and the lens bend them).
 *
 * The lens problem: glass does not see other glass (three's transmission pass
 * renders only opaque objects), so a plain sphere in front of the glass mark
 * would show the room behind it and the mark would simply vanish. The fix is
 * a TWIN of the mark: the same geometry with a cheap opaque "glass look"
 * shader that draws ONLY into the transmission render target and ONLY inside
 * the lens's screen disk. In the main pass it writes nothing. So the lens
 * refracts (flips, magnifies) the mark, while the real mark keeps refracting
 * the room.
 */

export interface LensScene {
  rig: THREE.Group
  turn: THREE.Group
  mark: GlassLogo
  lens: THREE.Mesh
  /** lens radius in rig units */
  lensRadius: number
  rings: THREE.Mesh
  ringU: { uPhase: { value: number }; uStrength: { value: number } }
  dispose(): void
}

const PROXY_VERT = /* glsl */ `
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vClip;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vN = normalize(normalMatrix * normal);
    vV = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
    vClip = gl_Position.xyw;
  }
`

// the twin: dark glassy body, bright bevel rims and the studio strips' glints
const PROXY_FRAG = /* glsl */ `
  uniform vec4 uDisk;      // lens disk: ndc centre xy, radius (ndc y units), aspect
  uniform vec3 uBody;
  uniform vec3 uRim;
  uniform float uCore;     // 1 = the emerald core (flat HDR green)
  varying vec3 vN;
  varying vec3 vV;
  varying vec3 vClip;
  void main() {
    vec2 ndc = vClip.xy / max(vClip.z, 1e-4);
    vec2 d = (ndc - uDisk.xy) * vec2(uDisk.w, 1.0);
    if (dot(d, d) > uDisk.z * uDisk.z) discard;
    vec3 n = normalize(vN);
    vec3 v = normalize(vV);
    float ndv = clamp(abs(dot(n, v)), 0.0, 1.0);
    float f = 1.0 - ndv;
    float rim = f * f * f;
    float sR = exp(-(n.x - 0.6) * (n.x - 0.6) / 0.014);
    float sL = exp(-(n.x + 0.58) * (n.x + 0.58) / 0.02);
    float top = smoothstep(0.45, 0.95, n.y);
    vec3 glassy = uBody * (0.45 + 0.55 * ndv) + uRim * (rim * 1.5 + sR * 0.8 + sL * 0.55 + top * 0.45);
    vec3 core = uBody * (0.7 + 0.5 * ndv) + uRim * rim * 0.6;
    gl_FragColor = vec4(mix(glassy, core, uCore), 1.0);
  }
`

const RING_VERT = /* glsl */ `
  varying vec2 vP;
  void main() {
    vP = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

// concentric hairlines of light — sound rings ("hark" = listen), a lens target
const RING_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uStrength;
  uniform float uPhase;
  uniform float uGap;
  uniform float uInner;
  uniform float uOuter;
  varying vec2 vP;
  void main() {
    float r = length(vP);
    float x = r / uGap - uPhase;
    float dr = (0.5 - abs(fract(x) - 0.5)) * uGap;       // distance to the nearest ring
    float w = max(0.006, fwidth(r) * 0.85);
    float line = exp(-dr * dr / (w * w));
    float mask = smoothstep(uInner, uInner + 0.35, r) * (1.0 - smoothstep(uOuter - 1.4, uOuter, r));
    float fall = 1.0 / (1.0 + r * 0.55);
    gl_FragColor = vec4(uColor * line * mask * fall * uStrength, 1.0);
  }
`

export function buildScene(opts: {
  mobile: boolean
  /** the composer's scene targets: the twin writes nothing into these */
  mainTargets: THREE.WebGLRenderTarget[]
}): LensScene {
  const { mobile, mainTargets } = opts
  const rig = new THREE.Group()
  const turn = new THREE.Group()
  rig.add(turn)

  // the mark: thick clear glass, a touch of clearcoat for a second crisp reflection
  const markMat = glass({ thickness: 0.42, ior: 1.52, dispersion: 0.42, env: 1.6, coat: 0.8 })
  const mark = glassLogo({ depth: 0.26, material: markMat, coreStrength: 2.2 })
  mark.glow.intensity = 1
  turn.add(mark.root)

  // ---- the twin (lens-only view of the mark)
  const disk = { value: new THREE.Vector4(0, 0, 0, 1) }
  const twinMat = new THREE.ShaderMaterial({
    uniforms: {
      uDisk: disk,
      uBody: { value: new THREE.Color('#12382d') },
      uRim: { value: new THREE.Color('#dffff0').multiplyScalar(0.8) },
      uCore: { value: 0 },
    },
    vertexShader: PROXY_VERT,
    fragmentShader: PROXY_FRAG,
  })
  const coreMat = new THREE.ShaderMaterial({
    uniforms: {
      uDisk: disk,
      uBody: { value: new THREE.Color(G.signal).multiplyScalar(1.35) },
      uRim: { value: new THREE.Color('#eafff4') },
      uCore: { value: 1 },
    },
    vertexShader: PROXY_VERT,
    fragmentShader: PROXY_FRAG,
  })
  const twins = [
    new THREE.Mesh(mark.loopA.geometry, twinMat),
    new THREE.Mesh(mark.loopB.geometry, twinMat),
    new THREE.Mesh(mark.core.geometry, coreMat),
  ]

  // ---- the lens
  const lensRadius = 0.56
  const seg = mobile ? 72 : 128
  const lensMat = glass({ thickness: 8, ior: 1.5, dispersion: 0.16, env: 1.35, coat: 0 })
  const lens = new THREE.Mesh(new THREE.SphereGeometry(1, seg, Math.round(seg * 0.75)), lensMat)
  lens.scale.setScalar(lensRadius)
  rig.add(lens)

  // The twin draws only outside the composer's main pass (i.e. into the
  // transmission target), and only inside the lens's screen disk.
  const lp = new THREE.Vector3()
  const cp = new THREE.Vector3()
  const ls = new THREE.Vector3()
  const gate = (renderer: THREE.WebGLRenderer, camera: THREE.Camera, mat: THREE.ShaderMaterial) => {
    const rt = renderer.getRenderTarget()
    const main = rt === null || mainTargets.includes(rt as THREE.WebGLRenderTarget)
    mat.colorWrite = !main
    mat.depthWrite = !main
    if (main) return
    const cam = camera as THREE.PerspectiveCamera
    lens.getWorldPosition(lp)
    cp.setFromMatrixPosition(cam.matrixWorld)
    ls.setFromMatrixScale(lens.matrixWorld)
    const R = ls.x
    const dist = Math.max(R * 1.001, lp.distanceTo(cp))
    const alpha = Math.asin(Math.min(0.999, R / dist))
    const tanV = Math.tan(THREE.MathUtils.degToRad((cam.fov ?? 30) / 2))
    lp.project(cam)
    const r = (Math.tan(alpha) / tanV) * 1.02
    const ok = Number.isFinite(lp.x) && Number.isFinite(lp.y) && Number.isFinite(r)
    disk.value.set(ok ? lp.x : 0, ok ? lp.y : 0, ok ? r : 0, cam.aspect || 1)
  }
  for (const t of twins) {
    const mat = t.material as THREE.ShaderMaterial
    t.onBeforeRender = (renderer, _s, camera) => gate(renderer, camera, mat)
    t.frustumCulled = false
    t.renderOrder = -1
  }
  twins[0].position.copy(mark.loopA.position)
  twins[1].position.copy(mark.loopB.position)
  twins[2].position.copy(mark.core.position)
  mark.root.add(...twins)

  // ---- listening rings behind the mark
  const ringU = {
    uColor: { value: new THREE.Color(G.mint).multiplyScalar(0.2) },
    uStrength: { value: 1 },
    uPhase: { value: 0 },
    uGap: { value: 0.34 },
    uInner: { value: 0.5 },
    uOuter: { value: 2.2 },
  }
  const rings = new THREE.Mesh(
    new THREE.PlaneGeometry(4.6, 4.6),
    new THREE.ShaderMaterial({
      uniforms: ringU,
      vertexShader: RING_VERT,
      fragmentShader: RING_FRAG,
      // additive light, but kept in the opaque list so glass can refract it
      transparent: false,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    }),
  )
  rings.position.z = -0.95
  rig.add(rings)

  return {
    rig,
    turn,
    mark,
    lens,
    lensRadius,
    rings,
    ringU,
    dispose() {
      twinMat.dispose()
      coreMat.dispose()
      lens.geometry.dispose()
      rings.geometry.dispose()
      ;(rings.material as THREE.Material).dispose()
    },
  }
}
