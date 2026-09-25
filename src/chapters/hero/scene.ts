import * as THREE from 'three'
import { G, edgeGlow, emerald, glass, glassLogo, smoothExtrude, type GlassLogo } from '../../kit/glass'

/*
 * THE LENS — the hero set.
 *
 *   the mark        glassLogo(): two thick bevelled glass loops + an emerald
 *                   core, 2.3 units tall, floating above…
 *   the plinth      a polished smoked-glass puck with a green light pool
 *                   beneath it (opaque + additive, so the puck refracts it)
 *                   and a soft bounce of emerald light on its top face
 *   the backdrop    a huge etched "HARK" in hairline outline far behind the
 *                   mark, so every loop visibly bends type
 *   satellites      a clear sphere, an opal ring, an iris-tinted cube (and a
 *                   small ice pebble on desktop) drifting at different depths
 *
 * Transmission rules followed here: the core, the backdrop and the pools are
 * all OPAQUE (the pools/backdrop additive), so three's transmission pass
 * captures them and every piece of glass refracts them. The loops are
 * double-sided, so the back faces of each loop land in the transmission
 * buffer too — the front loop keeps seeing the back one through itself in
 * the exploded view instead of punching a hole.
 */

/** mark height in world units */
export const MARK_S = 2.3
/** mark centre height */
export const MARK_Y = 0.25
/** plinth: radius, thickness, top face height */
export const PLINTH_R = 1.5
const PLINTH_T = 0.15
export const PLINTH_TOP = MARK_Y - MARK_S / 2 - 0.34

export interface Satellite {
  mesh: THREE.Mesh
  base: THREE.Vector3
  spin: THREE.Vector3
  phase: number
  bob: number
  /** resting orientation (idle spin is added from time) */
  rot: THREE.Euler
}

export interface HeroSet {
  /** mark pivot: bob, sway, turn (the loops/core animate inside it) */
  pivot: THREE.Group
  logo: GlassLogo
  /** each part's resting centre (mark-local), for callouts */
  centres: { loopA: THREE.Vector3; loopB: THREE.Vector3; core: THREE.Vector3 }
  /** things that follow the camera's orbit (with lag): backdrop + satellites */
  rig: THREE.Group
  backdrop: THREE.Mesh
  plinth: THREE.Mesh
  poolUnder: THREE.Mesh
  poolTop: THREE.Mesh
  sats: Satellite[]
  loopMat: THREE.MeshPhysicalMaterial
  /** fresnel rim on the loops: the light-catching edge */
  rimMat: THREE.ShaderMaterial
  coreMat: THREE.MeshPhysicalMaterial
  plinthMat: THREE.MeshPhysicalMaterial
  satMats: THREE.MeshPhysicalMaterial[]
  backdropMat: THREE.MeshBasicMaterial
}

/** the loops: crystal glass, faintly green where it's thick, sharp clearcoat */
function loopMaterial(mobile: boolean): THREE.MeshPhysicalMaterial {
  const m = glass({ thickness: 0.42, ior: 1.52, dispersion: 0.6, env: 1.5, coat: 1, tint: '#e2fff2', tintDistance: 2.6 }).clone()
  m.side = THREE.DoubleSide
  m.dispersion = mobile ? 0 : 0.6
  return m
}

/**
 * A soft pool of light on a horizontal plane (additive). Unlike the kit's
 * caustic() it falls to exactly zero before the quad's edge (no visible
 * square), and can add a ring of light under a rim. `opaque` puts it in the
 * opaque list so glass above it refracts it.
 */
export function lightPool(o: { size: number; color: THREE.ColorRepresentation; strength: number; ring?: number; ringR?: number; opaque?: boolean }): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    transparent: !o.opaque,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    toneMapped: false,
    uniforms: {
      uColor: { value: new THREE.Color(o.color) },
      uStrength: { value: o.strength },
      uTime: { value: 0 },
      uRing: { value: o.ring ?? 0 },
      uRingR: { value: o.ringR ?? 0.5 },
    },
    vertexShader: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uStrength, uTime, uRing, uRingR; varying vec2 vUv;
      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        float r = length(p);
        float fall = 1.0 - smoothstep(0.5, 1.0, r);
        float pool = exp(-r * r * 5.0);
        float dr = (r - uRingR) / 0.05;
        float ring = exp(-dr * dr) * uRing;
        float a = atan(p.y, p.x + 1e-4);
        float c = 0.5 + 0.5 * sin(r * 15.0 - uTime * 1.2 + 1.4 * sin(a * 3.0 + uTime * 0.4));
        float shimmer = mix(0.86, 1.08, c * clamp(1.0 - r * 1.4, 0.0, 1.0));
        gl_FragColor = vec4(uColor * (pool * shimmer + ring) * fall * uStrength, 1.0);
      }
    `,
  })
  const m = new THREE.Mesh(new THREE.PlaneGeometry(o.size, o.size), mat)
  m.rotation.x = -Math.PI / 2
  return m
}

/** Etched outline type on a canvas, drawn white on black for additive use. */
function etchedWord(word: string): { texture: THREE.CanvasTexture; aspect: number } {
  const px = 520
  const cv = document.createElement('canvas')
  const g = cv.getContext('2d')!
  const font = `300 ${px}px 'Geist Variable', 'Geist', system-ui, sans-serif`
  const track = px * 0.02
  g.font = font
  const measure = () => {
    let w = 0
    for (const ch of word) w += g.measureText(ch).width + track
    return w - track
  }
  const w = Math.ceil(measure() * 1.02) + 80
  const h = Math.ceil(px * 0.96)
  cv.width = Math.min(4096, w)
  cv.height = h
  const texture = new THREE.CanvasTexture(cv)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  const draw = () => {
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.globalCompositeOperation = 'source-over'
    g.fillStyle = '#000'
    g.fillRect(0, 0, cv.width, cv.height)
    g.font = font
    g.textBaseline = 'alphabetic'
    const total = measure()
    let x = (cv.width - total) / 2
    const y = h * 0.86
    for (const ch of word) {
      // a faint frosted fill, then the etched hairline edge
      g.fillStyle = 'rgba(255,255,255,0.11)'
      g.fillText(ch, x, y)
      g.lineWidth = 3.6
      g.strokeStyle = 'rgba(255,255,255,0.95)'
      g.strokeText(ch, x, y)
      x += g.measureText(ch).width + track
    }
    // lit from above: the etch fades toward its foot
    g.globalCompositeOperation = 'multiply'
    const grad = g.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, '#ffffff')
    grad.addColorStop(0.55, '#b8b8b8')
    grad.addColorStop(1, '#303030')
    g.fillStyle = grad
    g.fillRect(0, 0, cv.width, cv.height)
    g.globalCompositeOperation = 'source-over'
    texture.needsUpdate = true
  }
  draw()
  document.fonts
    ?.load(font)
    .then(() => draw())
    .catch(() => {})
  document.fonts?.ready.then(() => draw()).catch(() => {})
  return { texture, aspect: cv.width / cv.height }
}

function roundedSquare(size: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const h = size / 2
  s.moveTo(-h + r, -h)
  s.lineTo(h - r, -h)
  s.quadraticCurveTo(h, -h, h, -h + r)
  s.lineTo(h, h - r)
  s.quadraticCurveTo(h, h, h - r, h)
  s.lineTo(-h + r, h)
  s.quadraticCurveTo(-h, h, -h, h - r)
  s.lineTo(-h, -h + r)
  s.quadraticCurveTo(-h, -h, -h + r, -h)
  return s
}

export function buildMark(mobile: boolean): Pick<HeroSet, 'pivot' | 'logo' | 'centres' | 'loopMat' | 'coreMat' | 'rimMat'> {
  const loopMat = loopMaterial(mobile)
  const logo = glassLogo({ depth: 0.27, material: loopMat, coreStrength: 2.4 })
  // an OPAQUE emerald: the loops refract it (a transmissive core would vanish behind them)
  const coreMat = emerald(2.4).clone()
  coreMat.transmission = 0
  coreMat.roughness = 0.06
  coreMat.envMapIntensity = 2.2
  logo.core.material = coreMat
  // light from inside: the emerald burns brightest at its heart and cools
  // toward its facets, so it reads as a lit gem rather than a flat green tile
  logo.core.geometry.computeBoundingBox()
  const cb = logo.core.geometry.boundingBox!
  const cc = cb.getCenter(new THREE.Vector3())
  const cr = Math.max(cb.max.x - cb.min.x, cb.max.y - cb.min.y) * 0.5
  coreMat.onBeforeCompile = sh => {
    sh.uniforms.uCoreC = { value: new THREE.Vector2(cc.x, cc.y) }
    sh.uniforms.uCoreR = { value: cr }
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCoreP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCoreP = position;')
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCoreP;\nuniform vec2 uCoreC;\nuniform float uCoreR;')
      .replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n{ float rr = clamp(length(vCoreP.xy - uCoreC) / uCoreR, 0.0, 1.0); totalEmissiveRadiance *= mix(1.7, 0.28, rr * rr); }',
      )
  }
  coreMat.customProgramCacheKey = () => 'hark-hero-core'
  logo.glow.intensity = 1.6
  logo.glow.distance = 3.2
  // a whisper of fresnel light on the loops' grazing edges (drawn after the glass)
  const rimMat = edgeGlow('#e6fff3', 3, 0.42)
  for (const loop of [logo.loopA, logo.loopB]) {
    const rim = new THREE.Mesh(loop.geometry, rimMat)
    rim.renderOrder = 3
    loop.add(rim)
  }
  const pivot = new THREE.Group()
  pivot.position.y = MARK_Y
  logo.root.scale.setScalar(MARK_S)
  pivot.add(logo.root)
  const centre = (m: THREE.Mesh) => {
    m.geometry.computeBoundingBox()
    return m.geometry.boundingBox!.getCenter(new THREE.Vector3())
  }
  return { pivot, logo, loopMat, rimMat, coreMat, centres: { loopA: centre(logo.loopA), loopB: centre(logo.loopB), core: centre(logo.core) } }
}

export function buildStage(mobile: boolean): Omit<HeroSet, 'pivot' | 'logo' | 'centres' | 'loopMat' | 'coreMat' | 'rimMat'> {
  // ---- the plinth: a polished smoked-glass puck
  const plinthMat = glass({ tint: '#2c3444', tintDistance: 0.55, thickness: 0.35, frost: 0.03, dispersion: 0.25, env: 1.25, coat: 1, ior: 1.5 }).clone()
  const disc = new THREE.Shape()
  disc.absarc(0, 0, PLINTH_R, 0, Math.PI * 2, false)
  const plinth = new THREE.Mesh(smoothExtrude(disc, { depth: PLINTH_T, bevel: 0.055, curveSegments: mobile ? 64 : 110, crease: 0.9 }), plinthMat)
  plinth.rotation.x = -Math.PI / 2
  plinth.position.y = PLINTH_TOP - PLINTH_T / 2 - 0.055

  // ---- light pool beneath the puck (opaque + additive: the puck refracts it)
  const poolSize = PLINTH_R * 3.2
  const poolUnder = lightPool({ size: poolSize, color: '#4dffb0', strength: 0.4, ring: 0.7, ringR: (PLINTH_R * 0.97) / (poolSize / 2), opaque: true })
  poolUnder.position.y = PLINTH_TOP - PLINTH_T - 0.16
  poolUnder.renderOrder = -4
  // ---- the emerald's bounce on the puck's top face (drawn after the glass)
  const poolTop = lightPool({ size: 2.4, color: G.mint, strength: 0.2 })
  poolTop.position.y = PLINTH_TOP + 0.004
  poolTop.renderOrder = 2

  // ---- the etched backdrop word (opaque + additive, far behind)
  const { texture, aspect } = etchedWord('HARK')
  const bh = 2.9
  const backdropMat = new THREE.MeshBasicMaterial({
    map: texture,
    color: new THREE.Color(G.mist).multiplyScalar(0.38),
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: true,
  })
  const backdrop = new THREE.Mesh(new THREE.PlaneGeometry(bh * aspect, bh), backdropMat)
  backdrop.position.set(0, MARK_Y + 0.1, -5.5)
  backdrop.renderOrder = -5

  const rig = new THREE.Group()
  rig.add(backdrop)

  // ---- satellites
  const sats: Satellite[] = []
  const satMats: THREE.MeshPhysicalMaterial[] = []
  const add = (geo: THREE.BufferGeometry, mat: THREE.MeshPhysicalMaterial, base: [number, number, number], spin: [number, number, number], phase: number, bob = 0.07) => {
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(...base)
    rig.add(mesh)
    satMats.push(mat)
    sats.push({ mesh, base: new THREE.Vector3(...base), spin: new THREE.Vector3(...spin), phase, bob, rot: mesh.rotation })
    return mesh
  }
  const seg = mobile ? 48 : 72
  // clear sphere, high and behind on the left
  add(new THREE.SphereGeometry(0.34, seg, Math.round(seg * 0.75)), glass({ thickness: 0.7, ior: 1.5, dispersion: 0.55, env: 1.3, coat: 0.5 }).clone(), [-1.95, 1.3, -1.7], [0, 0.1, 0], 0.3)
  // opal ring, front right
  const ringMat = glass({ thickness: 0.3, dispersion: 0.35, iridescence: 0.9, env: 1.4, coat: 0.6 }).clone()
  const ring = add(new THREE.TorusGeometry(0.4, 0.085, mobile ? 32 : 48, mobile ? 96 : 140), ringMat, [1.85, -0.45, 0.85], [0.13, 0.19, 0.05], 1.7)
  ring.rotation.set(0.9, 0.4, 0.2)
  // rose-tinted rounded cube, low front left
  const cube = add(
    smoothExtrude(roundedSquare(0.44, 0.1), { depth: 0.3, bevel: 0.07, curveSegments: 12, crease: 0.7 }),
    glass({ tint: '#ffb8d4', tintDistance: 0.9, thickness: 0.5, dispersion: 0.4, env: 1.3, coat: 0.6 }).clone(),
    [1.55, 1.5, -2.2],
    [0.11, 0.16, 0.07],
    3.1,
  )
  cube.rotation.set(0.5, 0.6, 0.2)

  return { rig, backdrop, plinth, poolUnder, poolTop, sats, plinthMat, satMats, backdropMat }
}
