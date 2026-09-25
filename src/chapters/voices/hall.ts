import * as THREE from 'three'
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js'
import { glass, pane } from '../../kit/glass'
import { TESTIMONIALS } from '../../content'

/*
 * The Reflection hall — scene parts for the voices chapter.
 *
 *  - PANES: tall slabs of clear glass standing along a diagonal that recedes
 *    to the left, one per client voice.
 *  - ETCH: each pane carries the client's initials (large) and name + company
 *    (small) as edge-lit etching — light caught inside the glass. The etch is
 *    an ADDITIVE plane kept in the OPAQUE render list (transparent: false), so
 *    three's transmission pass captures it and every glass object in front of
 *    it (the quote mark, other panes) refracts it. A mirrored copy under the
 *    floor line is the glossy-floor reflection.
 *  - FLOOR: additive light only (no surface of its own, so it melts into the
 *    studio): a bright slot of light at each pane's foot and a warm pool
 *    spilling forward through the glass.
 *  - QUOTE MARK: a thick opening “ in smoked glass: two leaned commas (solid
 *    round head, tail hooking up to a fine point), a slab with a small round
 *    bevel so the silhouette keeps the glyph's taper.
 */

export const N = TESTIMONIALS.length
export const PANE_W = 1.9
export const PANE_H = 3.3
export const PANE_D = 0.12
export const FLOOR_Y = -PANE_H / 2 - 0.004
/** one step along the hall: left and back (passed panes leave the frame to the right) */
export const STEP = new THREE.Vector3(-2.6, 0, -2.45)

/** Where pane i stands (x, z) and its yaw — a gentle stagger keeps the row alive. */
export function paneSpot(i: number, out = new THREE.Vector3()) {
  const k = i % 2 === 0 ? 1 : -1
  return out.set(i * STEP.x, 0, i * STEP.z + k * 0.25)
}
export const paneYaw = (i: number) => (i % 2 === 0 ? -0.06 : 0.07)

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

const pad = (n: number) => String(n).padStart(2, '0')

const SANS = "'Geist Variable', 'Geist', system-ui, sans-serif"
const MONO = "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace"

/** draw text with manual tracking (Safari has no ctx.letterSpacing) */
function tracked(g: CanvasRenderingContext2D, text: string, cx: number, y: number, track: number) {
  const chars = [...text]
  const widths = chars.map(c => g.measureText(c).width)
  const total = widths.reduce((a, b) => a + b, 0) + track * Math.max(0, chars.length - 1)
  let x = cx - total / 2
  const align = g.textAlign
  g.textAlign = 'left'
  chars.forEach((c, i) => {
    g.fillText(c, x, y)
    x += widths[i] + track
  })
  g.textAlign = align
}

/** etch canvas: W x H, the pane's content block (initials, rule, name, company) */
export const ETCH_W = 1.62
export const ETCH_H = 2.3
/** y of the etch block's centre on the pane (pane-local) */
export const ETCH_Y = 0.12

function drawEtch(cv: HTMLCanvasElement, i: number) {
  const t = TESTIMONIALS[i]
  const W = cv.width
  const H = cv.height
  const s = W / 512
  const g = cv.getContext('2d')!
  g.clearRect(0, 0, W, H)
  g.fillStyle = '#ffffff'
  g.textBaseline = 'alphabetic'
  g.textAlign = 'center'

  // index, top
  g.globalAlpha = 0.62
  g.font = `500 ${Math.round(19 * s)}px ${MONO}`
  tracked(g, `${pad(i + 1)} — ${pad(N)}`, W / 2, 62 * s, 5 * s)

  // initials: soft halo first (light scattering in the etch), then the crisp cut
  const ini = initials(t.name)
  const size = Math.round(300 * s)
  g.font = `560 ${size}px ${SANS}`
  const base = 470 * s
  const track = -0.05 * size
  g.save()
  g.globalAlpha = 0.32
  g.shadowColor = 'rgba(255, 255, 255, 1)'
  g.shadowBlur = 26 * s
  tracked(g, ini, W / 2, base, track)
  g.restore()
  // lit from the foot of the pane: brighter toward the bottom
  const grad = g.createLinearGradient(0, base - size * 0.72, 0, base)
  grad.addColorStop(0, 'rgba(255,255,255,0.7)')
  grad.addColorStop(1, 'rgba(255,255,255,1)')
  g.fillStyle = grad
  g.globalAlpha = 1
  tracked(g, ini, W / 2, base, track)
  g.fillStyle = '#ffffff'

  // hairline
  g.globalAlpha = 0.55
  g.fillRect(W / 2 - 34 * s, 530 * s, 68 * s, Math.max(1, 2 * s))

  // name + company
  g.globalAlpha = 0.95
  g.font = `500 ${Math.round(34 * s)}px ${SANS}`
  tracked(g, t.name, W / 2, 596 * s, -0.4 * s)
  g.globalAlpha = 0.6
  g.font = `500 ${Math.round(16 * s)}px ${MONO}`
  tracked(g, t.company.toUpperCase(), W / 2, 640 * s, 3.2 * s)
  g.globalAlpha = 1
}

const ETCH_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`
const ETCH_FRAG = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  uniform float uIntensity, uReflect;
  varying vec2 vUv;
  void main() {
    vec2 uv = vUv;
    float fade = 1.0;
    if (uReflect > 0.5) {
      uv.y = 1.0 - uv.y;
      // the mirrored copy fades away from the floor line
      fade = smoothstep(0.35, 1.0, vUv.y) * 0.16;
    }
    float a = texture2D(uMap, uv).a;
    gl_FragColor = vec4(uColor * (a * uIntensity * fade), 1.0);
  }
`

export interface Etch {
  /** inside the slab, opaque list: what glass (the pane, the quote mark) refracts */
  mesh: THREE.Mesh
  /**
   * Phones only: a crisp copy on the pane's front face, drawn after the glass
   * (transparent list). Phones render transmission at half resolution, so the
   * refracted etch alone reads soft; the inner copy then becomes its glow.
   */
  face: THREE.Mesh | null
  mirror: THREE.Mesh
  uniforms: { uIntensity: { value: number } }
  faceUniforms: { uIntensity: { value: number } } | null
  mirrorUniforms: { uIntensity: { value: number } }
  redraw(): void
}

/** The etched voice for pane i (direct + mirrored copies share one texture). */
export function makeEtch(i: number, mobile: boolean): Etch {
  const cv = document.createElement('canvas')
  cv.width = 512
  cv.height = Math.round((cv.width * ETCH_H) / ETCH_W)
  drawEtch(cv, i)
  const tex = new THREE.CanvasTexture(cv)
  tex.anisotropy = 4
  const color = new THREE.Color('#ffeedf')
  const mk = (reflect: number, face = false) => {
    const uniforms = {
      uMap: { value: tex },
      uColor: { value: color },
      uIntensity: { value: 1 },
      uReflect: { value: reflect },
    }
    const mat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: ETCH_VERT,
      fragmentShader: ETCH_FRAG,
      // additive light, but in the OPAQUE list so glass refracts it (the
      // face copy is the exception: it must draw after the glass)
      transparent: face,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(ETCH_W, ETCH_H), mat)
    return { mesh, uniforms }
  }
  const a = mk(0)
  const b = mk(1)
  const f = mobile ? mk(0, true) : null
  return {
    mesh: a.mesh,
    face: f ? f.mesh : null,
    mirror: b.mesh,
    uniforms: a.uniforms,
    faceUniforms: f ? f.uniforms : null,
    mirrorUniforms: b.uniforms,
    redraw() {
      drawEtch(cv, i)
      tex.needsUpdate = true
    },
  }
}

/* -------------------------------------------------------------- edge light */

const EDGE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;
  varying vec2 vUv;
  void main() {
    float y = (vUv.y - 0.5) * 2.0;
    float x = (vUv.x - 0.5) * 2.0;
    float core = exp(-y * y * 18.0);
    float ends = 1.0 - smoothstep(0.82, 1.0, abs(x));
    gl_FragColor = vec4(uColor * (core * ends * uIntensity), 1.0);
  }
`

/**
 * Edge-lit glass: light injected at the pane's foot travels through the slab
 * and leaks out along its bottom and top edges. A thin additive line (opaque
 * list, so glass in front still refracts it).
 */
export function makeEdgeLine(width: number): { mesh: THREE.Mesh; uniforms: { uIntensity: { value: number } } } {
  const uniforms = { uColor: { value: new THREE.Color('#ffd9b8') }, uIntensity: { value: 1 } }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: ETCH_VERT,
    fragmentShader: EDGE_FRAG,
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  return { mesh: new THREE.Mesh(new THREE.PlaneGeometry(width, 0.07), mat), uniforms }
}

/* ------------------------------------------------------------------ floor */

const FLOOR_FRAG = /* glsl */ `
  uniform vec4 uPanes[${N}];      // x, z, yaw, glow
  uniform vec3 uWarm, uRose, uLine;
  uniform float uHalfW, uFade;
  varying vec3 vWorld;
  void main() {
    vec3 col = vec3(0.0);
    for (int i = 0; i < ${N}; i++) {
      vec4 p = uPanes[i];
      vec2 d = vWorld.xz - p.xy;
      float c = cos(p.z), s = sin(p.z);
      vec2 l = vec2(c * d.x - s * d.y, s * d.x + c * d.y);   // pane-local: x along the width, y through it
      float along = 1.0 - smoothstep(uHalfW - 0.12, uHalfW + 0.1, abs(l.x));
      float line = exp(-(l.y * l.y) / 0.0016) * along;
      // light that went through the glass spills forward, warm and wide
      vec2 q = vec2(l.x / (uHalfW * 1.35), (l.y - 0.55) / 1.25);
      float pool = exp(-dot(q, q) * 1.6);
      vec2 r = vec2(l.x / (uHalfW * 2.6), (l.y - 0.2) / 2.8);
      float halo = exp(-dot(r, r) * 1.2);
      col += p.w * (uLine * line + uWarm * pool * 0.34 + uRose * halo * 0.08);
    }
    gl_FragColor = vec4(col * uFade, 1.0);
  }
`
const FLOOR_VERT = /* glsl */ `
  varying vec3 vWorld;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`

export interface Floor {
  mesh: THREE.Mesh
  panes: THREE.Vector4[]
  uniforms: { uFade: { value: number } }
}

export function makeFloor(): Floor {
  const panes = Array.from({ length: N }, () => new THREE.Vector4())
  const uniforms = {
    uPanes: { value: panes },
    uWarm: { value: new THREE.Color('#ffae6b') },
    uRose: { value: new THREE.Color('#ff6f9c') },
    uLine: { value: new THREE.Color('#ffe3c7').multiplyScalar(2.6) },
    uHalfW: { value: PANE_W / 2 },
    uFade: { value: 1 },
  }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FLOOR_VERT,
    fragmentShader: FLOOR_FRAG,
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(44, 34), mat)
  mesh.rotation.x = -Math.PI / 2
  mesh.position.set(STEP.x * 3.5, FLOOR_Y, STEP.z * 3.5)
  mesh.frustumCulled = false
  return { mesh, panes, uniforms }
}

/* ------------------------------------------------------------ quote mark */

/**
 * One mark of an opening “, head down, in head radii (head centre at the
 * origin): a solid round head (~55% of the height) whose tail springs from its
 * left side, rises and hooks right to a fine point. Drawn thin at the tip —
 * the bevel adds its radius all round.
 */
function quoteComma(): THREE.Shape {
  const s = new THREE.Shape()
  const join = THREE.MathUtils.degToRad(102)
  s.moveTo(-1, 0)
  // outer edge of the tail: up the head's left side, arcing over to the tip
  s.bezierCurveTo(-1.02, 1.3, -0.72, 2.32, 0.46, 2.64)
  // inner edge: back down into the notch on the head's crown
  s.bezierCurveTo(-0.02, 2.34, -0.3, 1.66, Math.cos(join), Math.sin(join))
  // the head: round over the right, under, and up to the start
  s.absarc(0, 0, 1, join, -Math.PI, true)
  return s
}

/** italic lean of the mark (11°) */
const LEAN = Math.tan(THREE.MathUtils.degToRad(11))
/** head centres apart, in head radii: the pair nearly touching reads as one “ */
const PAIR = 2.4

/**
 * One comma of the glass “: a thick slab with a small round bevel, so the
 * silhouette keeps the glyph's taper and the flat faces stay clean. Leaned,
 * then given smooth (creased) normals.
 */
function glassComma(ox: number, mobile: boolean): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(quoteComma(), {
    depth: 0.55,
    bevelEnabled: true,
    bevelThickness: 0.1,
    bevelSize: 0.07,
    bevelSegments: mobile ? 9 : 12,
    curveSegments: mobile ? 56 : 72,
    steps: 1,
  })
  g.translate(ox, 0, -0.275)
  g.applyMatrix4(new THREE.Matrix4().makeShear(0, 0, LEAN, 0, 0, 0))
  const out = toCreasedNormals(g, Math.PI / 3)
  g.dispose()
  return out
}

export interface QuoteMark {
  root: THREE.Group
  /** the two commas (animate apart in depth for an exploded view) */
  left: THREE.Mesh
  right: THREE.Mesh
}

/** The glass “: two leaned commas, centred on the root, 1 unit tall. */
export function makeQuoteMark(mobile: boolean): QuoteMark {
  const ga = glassComma(-PAIR / 2, mobile)
  const gb = glassComma(PAIR / 2, mobile)
  const box = new THREE.Box3()
  ga.computeBoundingBox()
  gb.computeBoundingBox()
  box.copy(ga.boundingBox!).union(gb.boundingBox!)
  const c = box.getCenter(new THREE.Vector3())
  const k = 1 / Math.max(1e-3, box.max.y - box.min.y)
  for (const g of [ga, gb]) {
    g.translate(-c.x, -c.y, 0)
    g.scale(k, k, k)
    g.computeBoundingSphere()
  }
  // a warm smoke: dense enough that the heads read solid, never milky
  const mat = glass({ thickness: 0.9, ior: 1.5, dispersion: 0.6, env: 1.35, tint: '#d4bfc6', tintDistance: 1.3 })
  const left = new THREE.Mesh(ga, mat)
  const right = new THREE.Mesh(gb, mat)
  const root = new THREE.Group()
  root.add(left, right)
  return { root, left, right }
}

/** Clear float glass with the faintest warm body. */
export function paneMaterial(): THREE.Material {
  return glass({ thickness: 0.35, ior: 1.5, dispersion: 0.22, env: 1.35, tint: '#fff4ea', tintDistance: 2.6 })
}

/** A tall clear pane; one geometry shared by all. */
export function makePaneGeometry(): THREE.BufferGeometry {
  return pane(PANE_W, PANE_H, { radius: 0.09, depth: PANE_D, bevel: 0.035, material: paneMaterial() }).geometry
}

/** Load the fonts the etch uses (bounded wait — never block init for long). */
export function etchFontsReady(timeout = 1800): Promise<boolean> {
  const fonts = document.fonts
  if (!fonts?.load) return Promise.resolve(false)
  const loads = Promise.all([fonts.load(`560 200px ${SANS}`), fonts.load(`500 20px ${MONO}`), fonts.load(`500 20px ${SANS}`)])
    .then(() => true)
    .catch(() => false)
  return Promise.race([loads, new Promise<boolean>(r => setTimeout(() => r(false), timeout))])
}
